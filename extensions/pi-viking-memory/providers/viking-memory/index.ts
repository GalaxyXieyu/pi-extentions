import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfigFromModuleUrl, type VikingMemoryConfig } from "./config.js";
import { VikingMemoryClient } from "./client.js";
import { extractMessages } from "./capture.js";
import { injectRecall } from "../../core/format.js";
import { isSelected } from "../../core/selection.js";
import { VikingMemoryProvider } from "./provider.js";
import { registerTools } from "./tools.js";
import { memoryStats, measure } from "../../core/runtime.js";
import { loadCanonicalConfig } from "../../core/config-protocol.js";
import { localIdentity, requestContext, resolverFromEnv, type MemoryRequestContext } from "../../core/contracts.js";
import { auditReceipt, handleReviewPrompts, recentAuditRecords, runConsolidationPass } from "../../core/runtime.js";
import { makePilotComplete } from "../../core/pilot.js";
import { resolveWorkspaceIdentity } from "../../core/workspace-identity.js";

/** Keep in sync with package.json; surfaced in /viking-memory for version checks. */
export const EXTENSION_VERSION = "0.2.10";

export default async function (pi: ExtensionAPI) {
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled || !isSelected("viking-memory")) return;
  const canonical = loadCanonicalConfig();
  if (!canonical.valid) return;
  config.recallLimit = canonical.config.retrieval.limit;
  config.recallTokenBudget = canonical.config.retrieval.maxChars;
  config.minQueryLength = canonical.config.retrieval.minQueryLength;
  config.syncTurns = canonical.config.capture.enabled;
  config.captureAssistantTurns = canonical.config.capture.assistantTurns;
  config.captureMaxLength = canonical.config.capture.maxLength;

  // One optional override is enough: PI_MEMORY_WORKSPACE_ID. Otherwise derive
  // a stable ID from Git origin so clones on different machines share a project.
  const workspace = resolveWorkspaceIdentity({
    explicitId: process.env.PI_MEMORY_WORKSPACE_ID || process.env.MEMORY_WORKSPACE_ID || config.groupId,
  });
  config.groupId = workspace.id;

  const client = new VikingMemoryClient(config);
  const provider = new VikingMemoryProvider(client, config);
  const log = makeLogger(config);
  let connected = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let conversationId = "";
  let syncedEntryCount = 0;
  let pendingPrompt = "";
  let recallBlock: string | null = null;
  let toolsRegistered = false;
  const resolver = resolverFromEnv();
  let identity = localIdentity({ userId: config.userId, agentId: config.assistantId, workspaceId: config.groupId });
  const requestContextValue: MemoryRequestContext = requestContext(identity, { purpose: canonical.config.retrieval.purpose || "coding", policyVersion: canonical.config.policyVersion, configRevision: canonical.config.revision, lifecycle: { expiryEnabled: canonical.config.lifecycle.expiryEnabled, conflictPolicy: canonical.config.lifecycle.conflictPolicy } });

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      conversationId = normalizeId(ctx?.sessionManager?.getSessionId?.() || `pi_${Date.now()}`);
      const resolved = await resolver.resolve({ piSessionId: conversationId, cwd: process.cwd(), env: process.env });
      if (!resolved) throw new Error("memory identity resolver returned no identity");
      identity = { ...resolved, workspaceId: config.groupId };
      requestContextValue.identity = identity;
      identity.sessionId = conversationId;
      requestContextValue.identity.sessionId = conversationId;
      connected = await client.health();
      if (!connected) {
        log("remote Viking Memory is not reachable or credentials are invalid");
        return;
      }
      if (!toolsRegistered) {
        registerTools(
          pi,
          provider,
          config,
          () => conversationId,
          () => requestContextValue,
          canonical.config.ui.cards.enabled ? {
            hint: canonical.config.ui.cards.hint,
            partialPrefix: canonical.config.ui.cards.partialPrefix,
            maxSummary: canonical.config.ui.cards.maxSummary,
          } : undefined,
        );
        toolsRegistered = true;
      }
      setStatus(ctx, connected, config, syncedEntryCount);
      started = true;
    })().finally(() => { startPromise = null; });
    return startPromise;
  };

  pi.on("session_start", async (_event, ctx) => { await start(ctx); });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    await start(ctx);
    if (!connected) return;
    // Refresh the pilot hook with this turn's ctx so the LLM funnel inherits
    // the pi session's active provider/auth. Zero standalone config.
    provider.setPilotComplete(makePilotComplete(() => ctx));
    pendingPrompt = String(event?.prompt || "");
  });

  pi.on("context", async (event: any) => {
    if (!connected || pendingPrompt.trim().length < config.minQueryLength) return;
    const query = pendingPrompt;
    pendingPrompt = "";
    const result = await measure("recall", provider.id, () => provider.recall({
      query,
      sessionId: conversationId,
      purpose: "coding",
      limit: config.recallLimit,
      maxChars: config.recallTokenBudget * 4,
      context: requestContextValue,
    }));
    if (!result.raw || (result.raw as any)?.code !== 0) {
      log(`get_context failed: ${(result.raw as any)?.message || "no response"}`);
      return;
    }
    recallBlock = result.block;
    if (recallBlock) log(`recalled ${result.items.length} memory items for ${query.length}-char prompt`);
    return { messages: injectRecall(event.messages, recallBlock) };
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (!connected || !config.syncTurns) return;
    const extracted = extractMessages(ctx?.sessionManager?.getBranch?.() || [], syncedEntryCount, config);
    if (extracted.resetWatermark) syncedEntryCount = 0;
    if (extracted.messages.length === 0) {
      syncedEntryCount = extracted.nextEntryCount;
      return;
    }
    const result = await measure("capture", provider.id, () => provider.capture(conversationId, extracted.messages, requestContextValue));
    memoryStats.record({ type: "extraction", backend: provider.id, operation: "turn_end", count: result.count });
    if (result.conflicts?.length) {
      await handleReviewPrompts(ctx.ui, result.conflicts);
    }
    if (!result.accepted) {
      log(`session/add failed: ${result.error || "no response"}`);
      return;
    }
    syncedEntryCount = extracted.nextEntryCount;
    recallBlock = null;
    setStatus(ctx, connected, config, syncedEntryCount);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (!connected || !config.syncTurns) return;
    const extracted = extractMessages(ctx?.sessionManager?.getBranch?.() || [], syncedEntryCount, config);
    if (extracted.messages.length === 0) return;
    const result = await measure("capture", provider.id, () => provider.capture(`${conversationId}_shutdown`, extracted.messages, requestContextValue));
    memoryStats.record({ type: "extraction", backend: provider.id, operation: "shutdown", count: result.count });
    if (!result.accepted) log(`shutdown session/add failed: ${result.error || "no response"}`);
    else syncedEntryCount = extracted.nextEntryCount;
  });

  pi.on("agent_end", async () => { recallBlock = null; pendingPrompt = ""; });

  pi.registerCommand("viking-memory-capabilities", {
    description: "Show the active memory backend capabilities.",
    handler: async (_args: string, ctx: any) => { ctx.ui.notify(JSON.stringify(provider.capabilitiesSnapshot()), "info"); },
  });
  pi.registerCommand("viking-memory-stats", {
    description: "Show local memory operation statistics.",
    handler: async (_args: string, ctx: any) => { ctx.ui.notify(JSON.stringify(memoryStats.snapshot()), "info"); },
  });
  pi.registerCommand("viking-memory-consolidate", {
    description: "Scan the local memory ledger for duplicate/contradicting memories and promote findings to review.",
    handler: async (_args: string, ctx: any) => {
      const result = await runConsolidationPass(requestContextValue.identity, ctx.ui);
      const lines = result.findings.length
        ? result.findings.map((f) => `sim=${f.similarity.toFixed(2)} ${f.suggestion} | ${f.a.record.content.slice(0, 80)} <-> ${f.b.record.content.slice(0, 80)}`).join("\n")
        : "No similar/contradicting memories found.";
      ctx.ui.notify(`Consolidation: ${result.promoted} promoted, ${result.findings.length} findings.\n${lines}`);
    },
  });
  pi.registerCommand("viking-memory-audit", {
    description: "Show a redacted session audit summary.",
    handler: async (_args: string, ctx: any) => { ctx.ui.notify(auditReceipt(conversationId, requestContextValue.identity, recentAuditRecords(conversationId)), "info"); },
  });

  pi.registerCommand("viking-memory-workspace", {
    description: "Show the active Git-stable workspace and global memory bucket.",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(JSON.stringify({
        workspaceId: workspace.id,
        source: workspace.source,
        gitRemote: workspace.canonicalRemote || null,
        repositoryRoot: workspace.repositoryRoot || null,
        globalProfileGroup: "__pi_global__",
        recall: "current workspace events + global profiles only",
      }, null, 2), "info");
    },
  });

  pi.registerCommand("viking-memory", {
    description: "Remote Viking Memory status; use 'search <query>' to search memories.",
    handler: async (args: string, ctx: any) => {
      if (args.trim().startsWith("search ")) {
        const items = await provider.search(args.trim().slice(7), { limit: config.recallLimit, context: requestContextValue });
        ctx.ui.notify(items.length ? JSON.stringify(items) : "No results found.", "info");
        return;
      }
      ctx.ui.notify(`Viking Memory v${EXTENSION_VERSION}: ${connected ? "connected" : "disconnected"} | collection=${config.collectionName} | workspace=${workspace.id} (${workspace.source}) | conversation=${conversationId || "none"}`, connected ? "info" : "warning");
    },
  });
}

function normalizeId(value: string): string {
  const id = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(id) ? id.slice(0, 128) : `pi_${id}`.slice(0, 128);
}

function makeLogger(config: VikingMemoryConfig): (message: string) => void {
  return (message: string) => {
    if (config.logLevel !== "info") return;
    const file = process.env.VIKING_MEMORY_DEBUG_LOG;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never affect the Pi session.
    }
  };
}

function setStatus(ctx: any, connected: boolean, config: VikingMemoryConfig, synced: number): void {
  try {
    ctx?.ui?.setStatus?.(`Viking ${connected ? "✓" : "✗"} · ${config.collectionName} · ↕${synced}`);
  } catch {
    // Best effort across Pi versions.
  }
}
