#!/usr/bin/env node
import { register } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Nightly memory sweep entry point.
 *
 * Runs outside pi: it reads pi's session transcripts from disk, sends them
 * through the batch LLM curator, and writes accepted memories through the
 * active backend provider. Conversation capture never calls a model — this is
 * the only scheduled model work in the plugin.
 *
 *   node --experimental-strip-types scripts/nightly-sweep.mjs [--since-hours 26] [--dry-run]
 *
 * LLM source: PI_MEMORY_LLM_URL (any OpenAI-compatible /chat/completions) when
 * set, otherwise a `pi -p --no-session --no-tools` subprocess so the sweep
 * reuses pi's own provider, model and stored credentials.
 */

const here = new URL("./", import.meta.url);
// Same .js -> .ts resolvers the test runner uses; must be registered before
// any dynamic import of the TypeScript sources.
for (const loader of [
  "../tests/register-loader.mjs",
  "../providers/openviking/tests/register-loader.mjs",
  "../providers/viking-memory/tests/register-loader.mjs",
]) await import(new URL(loader, here).href);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage: nightly-sweep.mjs [--since-hours N] [--dry-run] [--limit N] [--window-chars N] [--max-windows N] [--backend viking-memory|openviking] [--model provider/model] [--no-consolidate]`);
  process.exit(0);
}

const { loadCanonicalConfig } = await import("../core/config-protocol.js");
const { runNightlySweep, makePiCliComplete, piSessionsDir, nightlyContextFor } = await import("../core/nightly.js");
const { consolidateLocal } = await import("../core/consolidation.js");
const { llmEndpoint, llmExtractionEnabled } = await import("../core/llm-extractor.js");

const logFile = args.log || process.env.PI_MEMORY_NIGHTLY_LOG;
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  if (logFile) {
    try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${text}\n`); } catch { /* logging never breaks the sweep */ }
  }
};

const canonical = loadCanonicalConfig(process.env);
if (!canonical.valid) fail(`config invalid: ${canonical.errors.join("; ")}`);

const backend = args.backend || canonical.config.backend;
if (!backend) fail("PI_MEMORY_BACKEND is not set");

const { provider: baseProvider, config, makeProvider } = await buildProvider(backend, log);

if (!llmExtractionEnabled()) fail("PI_MEMORY_LLM_ENABLED=0 — LLM curation is disabled for every path, including the nightly sweep");

// An explicit endpoint wins so a machine with Ollama running never needs pi's
// credentials; otherwise borrow pi's provider/auth through the CLI.
const complete = llmEndpoint() ? undefined : makePiCliComplete({ model: args.model });
if (complete) log(`llm via pi CLI${args.model ? ` (${args.model})` : ""}`);
else log(`llm via endpoint ${llmEndpoint()}`);

const contexts = new Map();
const providers = new Map();
const providerFor = async (context) => {
  const key = String(context.identity.workspaceId || "local");
  if (!providers.has(key)) {
    const instance = await makeProvider(key);
    instance.setPilotComplete(complete ?? null);
    providers.set(key, instance);
  }
  return providers.get(key);
};

log(`sessions root: ${args.root || piSessionsDir()}`);
const report = await runNightlySweep({
  now: args.at ? new Date(args.at) : new Date(),
  sinceHours: args.sinceHours ? Number(args.sinceHours) : undefined,
  root: args.root,
  stateFile: args.state,
  dryRun: Boolean(args.dryRun),
  limit: args.limit ? Number(args.limit) : undefined,
  windowChars: args.windowChars ? Number(args.windowChars) : undefined,
  maxWindowsPerFile: args.maxWindows ? Number(args.maxWindows) : undefined,
  log,
  contextFor: (cwd) => {
    if (!contexts.has(cwd)) contexts.set(cwd, nightlyContextFor(cwd, { userId: config.userId || config.user, agentId: config.assistantId }));
    return contexts.get(cwd);
  },
  curate: async (batch, sessionId, context) => {
    if (args.dryRun) {
      log(`dry-run ${context.identity.workspaceId} :: ${sessionId} -> ${batch.length} messages, ${batch.reduce((n, m) => n + m.content.length, 0)} chars`);
      return { handled: true, count: 0, rejected: 0 };
    }
    const provider = await providerFor(context);
    return provider.curateBatch(batch, sessionId, context);
  },
});

let consolidationFindings = 0;
if (!args.dryRun && args.consolidate !== false) {
  for (const context of contexts.values()) {
    try { consolidationFindings += consolidateLocal(context.identity).length; } catch (error) { log(`consolidation skipped: ${String(error?.message || error)}`); }
  }
}

log(`done: scanned=${report.scanned} processed=${report.processed} skipped=${report.skipped} resumed=${report.resumed} windows=${report.windows} batches=${report.batches} memories=${report.memories} rejected=${report.rejected} oversize=${report.oversize} workspaces=${report.workspaces.length} consolidation=${consolidationFindings}`);
if (report.errors.length) log(`errors: ${report.errors.slice(0, 5).join(" | ")}`);
process.exit(report.errors.length && !report.processed ? 1 : 0);

async function buildProvider(id, logger) {
  if (id === "viking-memory") {
    const { loadConfigFromModuleUrl } = await import("../providers/viking-memory/config.js");
    const { VikingMemoryClient } = await import("../providers/viking-memory/client.js");
    const { VikingMemoryProvider } = await import("../providers/viking-memory/provider.js");
    const base = loadConfigFromModuleUrl(new URL("../providers/viking-memory/index.ts", here).href);
    applyCanonical(base);
    if (!base.apiKey) fail("MEMORY_API_KEY is not set — cannot write memories from the nightly sweep");
    const probe = new VikingMemoryProvider(new VikingMemoryClient(base), base);
    if (!(await probe.health())) logger("warning: backend health check failed; writes may be skipped");
    return {
      config: base,
      provider: probe,
      makeProvider: async (workspaceId) => {
        const scoped = { ...base, groupId: workspaceId };
        return new VikingMemoryProvider(new VikingMemoryClient(scoped), scoped);
      },
    };
  }
  const { loadConfigFromModuleUrl } = await import("../providers/openviking/config.js");
  const { OVClient } = await import("../providers/openviking/client.js");
  const { OpenVikingProvider } = await import("../providers/openviking/provider.js");
  const base = loadConfigFromModuleUrl(new URL("../providers/openviking/index.ts", here).href);
  applyCanonical(base);
  const probe = new OpenVikingProvider(new OVClient(base), base);
  if (!(await probe.health?.().catch(() => false))) logger("warning: OpenViking health check failed; writes may be skipped");
  return {
    config: base,
    provider: probe,
    makeProvider: async () => new OpenVikingProvider(new OVClient(base), base),
  };
}

function applyCanonical(target) {
  const c = canonical.config;
  target.recallLimit = c.retrieval.limit;
  target.recallTokenBudget = c.retrieval.maxChars;
  target.minQueryLength = c.retrieval.minQueryLength;
  if ("scoreThreshold" in target) target.scoreThreshold = c.retrieval.scoreThreshold ?? target.scoreThreshold;
  if ("captureMaxLength" in target) target.captureMaxLength = c.capture.maxLength;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--no-consolidate") out.consolidate = false;
    else if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

function fail(message) {
  console.error(`[nightly-sweep] ${message}`);
  process.exit(1);
}
