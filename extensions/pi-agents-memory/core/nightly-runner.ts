import { runNightlySweep, nightlyContextFor, type NightlyReport } from "./nightly.js";
import { consolidateLocal } from "./consolidation.js";
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryMessage } from "./provider.js";
import type { MemoryRequestContext } from "./contracts.js";
import type { LlmCompleteFn } from "./llm-extractor.js";

/**
 * Nightly sweep implementation, shared by every entry point.
 *
 * It deliberately lives in TypeScript inside the plugin rather than in a
 * standalone Node script: Node refuses `--experimental-strip-types` for files
 * under node_modules, so a scheduled job cannot import the plugin's sources
 * from an npm install. pi loads those same sources with its own transpiler, so
 * running the sweep inside the pi process works identically for a repo
 * checkout, an `npm:` install, and a `pi install <path>` dev install.
 *
 * Entry points: `/memory-nightly` (interactive) and a headless run started by
 * launchd with PI_MEMORY_NIGHTLY_RUN=1.
 */

export interface NightlyCurateResult {
  handled: boolean;
  count: number;
  rejected: number;
  error?: string;
}

export interface NightlyRunnerOptions {
  /** Backend adapter for one workspace. */
  providerFor: (workspaceId: string, context: MemoryRequestContext) => Promise<{
    curateBatch: (batch: MemoryMessage[], sessionId: string, context: MemoryRequestContext) => Promise<NightlyCurateResult>;
    setPilotComplete?: (complete: LlmCompleteFn | null) => void;
  }>;
  /** Identity inputs from the active backend config. */
  base: { userId?: string; agentId?: string; tenantId?: string; purpose?: "chat" | "coding" };
  /** pi's own completion hook; the sweep uses the session's provider and auth. */
  complete: LlmCompleteFn | null;
  sinceHours?: number;
  limit?: number;
  dryRun?: boolean;
  windowChars?: number;
  maxWindowsPerFile?: number;
  root?: string;
  stateFile?: string;
  consolidate?: boolean;
  log?: (line: string) => void;
}

export interface NightlyRunOutcome {
  report: NightlyReport;
  consolidation: number;
}

/** Parse the free-form args of `/memory-nightly` (same flags as the script). */
export function parseNightlyArgs(input: string): Partial<NightlyRunnerOptions> & { unknown: string[] } {
  const tokens = String(input || "").trim().split(/\s+/).filter(Boolean);
  const out: Partial<NightlyRunnerOptions> & { unknown: string[] } = { unknown: [] };
  const number = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : undefined);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--dry-run") out.dryRun = true;
    else if (token === "--no-consolidate") out.consolidate = false;
    else if (token === "--since-hours") out.sinceHours = number(tokens[++i]);
    else if (token === "--limit") out.limit = number(tokens[++i]);
    else if (token === "--window-chars") out.windowChars = number(tokens[++i]);
    else if (token === "--max-windows") out.maxWindowsPerFile = number(tokens[++i]);
    else if (token === "--root") out.root = tokens[++i];
    else if (token === "--state") out.stateFile = tokens[++i];
    else out.unknown.push(token);
  }
  return out;
}

export function nightlyArgsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<NightlyRunnerOptions> & { unknown: string[] } {
  return parseNightlyArgs(env.PI_MEMORY_NIGHTLY_ARGS || "");
}

/** One-line summary used by both the TUI notification and the headless log. */
export function nightlySummary(report: NightlyReport, consolidation: number): string {
  const errorText = report.errors.length ? ` errors=${report.errors.length}(${report.errors.slice(0, 2).join(",")})` : "";
  return `scanned=${report.scanned} processed=${report.processed} skipped=${report.skipped} resumed=${report.resumed} windows=${report.windows} batches=${report.batches} memories=${report.memories} rejected=${report.rejected} oversize=${report.oversize} workspaces=${report.workspaces.length} consolidation=${consolidation}${errorText}`;
}

export async function runNightlyInProcess(options: NightlyRunnerOptions): Promise<NightlyRunOutcome> {
  const log = lineSink(options);
  const contexts = new Map<string, MemoryRequestContext>();
  const providers = new Map<string, Awaited<ReturnType<NightlyRunnerOptions["providerFor"]>>>();

  const providerFor = async (context: MemoryRequestContext) => {
    const key = String(context.identity.workspaceId || "local");
    if (!providers.has(key)) {
      const provider = await options.providerFor(key, context);
      // In-session model use stays off; this hook is only for the sweep, which
      // is by definition not inside a conversation.
      provider.setPilotComplete?.(options.complete ?? null);
      providers.set(key, provider);
    }
    return providers.get(key)!;
  };

  const report = await runNightlySweep({
    sinceHours: options.sinceHours,
    root: options.root,
    stateFile: options.stateFile,
    dryRun: options.dryRun,
    limit: options.limit,
    windowChars: options.windowChars,
    maxWindowsPerFile: options.maxWindowsPerFile,
    log,
    contextFor: (cwd) => {
      if (!contexts.has(cwd)) {
        contexts.set(cwd, nightlyContextFor(cwd, {
          userId: options.base.userId,
          agentId: options.base.agentId,
          tenantId: options.base.tenantId,
          purpose: options.base.purpose,
        }));
      }
      return contexts.get(cwd)!;
    },
    curate: async (batch, sessionId, context) => {
      if (options.dryRun) {
        log(`dry-run ${context.identity.workspaceId} :: ${sessionId} -> ${batch.length} messages, ${batch.reduce((n, m) => n + m.content.length, 0)} chars`);
        return { handled: true, count: 0, rejected: 0 };
      }
      const provider = await providerFor(context);
      return provider.curateBatch(batch, sessionId, context);
    },
  });

  let consolidation = 0;
  if (!options.dryRun && options.consolidate !== false) {
    for (const context of contexts.values()) {
      try { consolidation += consolidateLocal(context.identity).length; } catch (error: any) { log(`consolidation skipped: ${String(error?.message || error)}`); }
    }
  }

  log(`nightly sweep done: ${nightlySummary(report, consolidation)}`);
  return { report, consolidation };
}

function lineSink(options: NightlyRunnerOptions): (line: string) => void {
  const file = process.env.PI_MEMORY_NIGHTLY_LOG || "";
  return (line: string) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    // Synchronous fd writes: the headless job exits with process.exit() when
    // the sweep ends, and a buffered async write dies with it, which looks
    // exactly like "the job ran and logged nothing".
    try { writeSync(1, text); } catch { /* stdout may be closed */ }
    if (file) {
      try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, text); } catch { /* logging never breaks the sweep */ }
    }
    try { options.log?.(line); } catch { /* the host logger is optional */ }
  };
}
