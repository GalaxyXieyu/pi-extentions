/**
 * Pi OpenViking Extension
 *
 * Integrates pi with an OpenViking context database for persistent,
 * cross-session memory. Syncs conversation turns to OV, recalls
 * relevant memories on each prompt, and commits sessions for long-term
 * memory extraction.
 *
 * Design informed by: OpenClaw (synchronous recall), Claude Code plugin
 * (most mature, production-hardened), Hermes (anti-pattern: stale prefetch).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfigFromModuleUrl, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools } from "./tools.js";
import { createTakeoverManager } from "./takeover.js";
import { isSelected } from "../../core/selection.js";
import { OpenVikingProvider } from "./provider.js";
import { injectRecall } from "../../core/format.js";
import { sanitizeSensitiveText } from "../../core/sensitive.mjs";
import { memoryStats, measure } from "../../core/runtime.js";
import { loadCanonicalConfig } from "../../core/config-protocol.js";
import { localIdentity, requestContext, resolverFromEnv, type MemoryRequestContext } from "../../core/contracts.js";
import { auditReceipt, handleReviewPrompts, recentAuditRecords, runConsolidationPass } from "../../core/runtime.js";

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled || !isSelected("openviking")) return;
  const canonical = loadCanonicalConfig();
  if (!canonical.valid) return;
  config.recallLimit = canonical.config.retrieval.limit;
  config.recallTokenBudget = canonical.config.retrieval.maxChars;
  config.minQueryLength = canonical.config.retrieval.minQueryLength;
  config.syncTurns = canonical.config.capture.enabled;
  config.captureAssistantTurns = canonical.config.capture.assistantTurns;
  config.captureMaxLength = canonical.config.capture.maxLength;
  config.captureToolResults = canonical.config.capture.toolResults;
  config.scoreThreshold = canonical.config.retrieval.scoreThreshold ?? config.scoreThreshold;
  config.recallQueryExpansion = canonical.config.retrieval.queryExpansion ? "auto" : "off";
  config.takeoverEnabled = canonical.config.lifecycle.consolidationEnabled ? config.takeoverEnabled : false;

  // Env overrides

  // --- Initialize modules ---
  const client = new OVClient(config);
  const provider = new OpenVikingProvider(client, config);
  const sync = new SyncManager(client, config, provider);
  const debugLog = (message: string) => {
    const file = process.env.OV_DEBUG_LOG;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${sanitizeSensitiveText(message)}\n`);
    } catch {
      // Best effort; logging must never affect pi.
    }
  };
  const takeover = createTakeoverManager({ pi, client, sync, config, log: debugLog });

  // Session state
  let connected = false;
  let bypassed = false;
  let profileBlock = "";
  let archiveOverview = "";
  let toolsRegistered = false;
  let compacted = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let pendingPrompt = "";
  let recallBlock: string | null = null;
  const resolver = resolverFromEnv();
  let identity = localIdentity({ userId: config.user || "pi", tenantId: config.account || "local", agentId: "pi", workspaceId: config.peerId || "local" });
  const requestContextValue: MemoryRequestContext = requestContext(identity, { purpose: canonical.config.retrieval.purpose || "coding", policyVersion: canonical.config.policyVersion, configRevision: canonical.config.revision, lifecycle: { expiryEnabled: canonical.config.lifecycle.expiryEnabled, conflictPolicy: canonical.config.lifecycle.conflictPolicy } });

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      // Bypass check
      const cwd = process.cwd();
      for (const pattern of config.bypassPatterns) {
        if (matchBypass(cwd, pattern)) {
          bypassed = true;
          started = true;
          return;
        }
      }

      // Health check
      const capabilityProbe = provider.probeCapabilities ? await provider.probeCapabilities() : null;
      connected = Boolean(capabilityProbe?.verified ?? await provider.health());
      if (!connected) {
        if (config.logLevel === "info") {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        return;
      }

      // Ensure OV session
      const piSessionId = ctx.sessionManager.getSessionId();
      const resolved = await resolver.resolve({ piSessionId, cwd: process.cwd(), env: process.env });
      if (!resolved) throw new Error("memory identity resolver returned no identity");
      identity = resolved;
      requestContextValue.identity = identity;
      identity.sessionId = piSessionId;
      requestContextValue.identity.sessionId = piSessionId;
      const ok = await sync.ensureSession(piSessionId);
      if (!ok) {
        if (config.logLevel !== "silent") {
          ctx.ui.notify("OpenViking: failed to create session", "error");
        }
        return;
      }
      if (provider.replayPending) await provider.replayPending();

      // Profile injection
      profileBlock = await buildSessionProfileBlock(client, config);

      const branch = typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
      if (config.takeoverEnabled) {
        takeover.restore(branch);
        sync.restoreWatermark(takeover.state.syncedEntryCount);
      } else if (sync.sessionId) {
        // Resume rehydration — fetch archive overview if session was previously committed.
        archiveOverview = await fetchArchiveOverview(client, sync.sessionId, config);
      }

      // Register tools (also needed for pi -c continuations).
      if (!toolsRegistered) {
        registerTools(
          pi,
          client,
          sync,
          provider,
          () => requestContextValue,
          canonical.config.ui.cards.enabled ? {
            hint: canonical.config.ui.cards.hint,
            partialPrefix: canonical.config.ui.cards.partialPrefix,
            maxSummary: canonical.config.ui.cards.maxSummary,
          } : undefined,
        );
        toolsRegistered = true;
      }
      updateStatus(ctx, connected, 0, sync.sessionId, config, takeover.state);

      started = true;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  };

  // --- session_start ---
  pi.on("session_start", async (event, ctx) => {
    await start(ctx);
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event, ctx) => {
    // session_start doesn't fire for pi -c continuations.
    await start(ctx);

    if (!connected || bypassed) return;

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    pendingPrompt = String(event.prompt || "");

    // Compose system prompt additions
    const parts: string[] = [];
    if (profileBlock) parts.push(profileBlock);
    if (!config.takeoverEnabled && archiveOverview && (compacted || archiveOverview.trim())) {
      parts.push(archiveOverview);
    }
    parts.push("OpenViking tools: viking_search, viking_read, viking_browse, viking_remember, viking_add_resource, viking_archive_expand.");

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + additions,
    };
  });

  // --- context ---
  pi.on("context", async (event, _ctx) => {
    if (!connected || bypassed) return;

    if (pendingPrompt.trim().length > 1) {
      const result = await measure("recall", provider.id, () => provider.recall({
        query: pendingPrompt,
        sessionId: sync.sessionId || undefined,
        purpose: "coding",
        limit: config.recallLimit,
        maxChars: config.recallTokenBudget * 4,
        context: requestContextValue,
      }));
      recallBlock = result.block;
      pendingPrompt = "";
    }

    const afterTakeover = config.takeoverEnabled
      ? takeover.transformContext(event.messages as any)
      : event.messages;
    return { messages: injectRecall(afterTakeover, recallBlock) };
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  });

  // --- turn_end ---
  pi.on("turn_end", async (event, ctx) => {
    if (!connected || bypassed || !config.syncTurns) return;

    const branch = ctx.sessionManager.getBranch();
    const result = await measure("capture", provider.id, () => sync.syncBranch(branch, requestContextValue));
    memoryStats.record({ type: "extraction", backend: provider.id, operation: "turn_end", count: result.added });
    debugLog(`turn_end: synced ${result.added} entries, ~${result.tokens} tokens`);
    await takeover.onTurnSynced(result.tokens);
    if (result.conflicts?.length) {
      await handleReviewPrompts(ctx.ui, result.conflicts);
    }
    updateStatus(ctx, connected, result.added, sync.sessionId, config, takeover.state);
  });

  // --- session_before_compact ---
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!connected || bypassed) return;

    if (config.takeoverEnabled) {
      const prep = (event as any)?.preparation ?? {};
      return await takeover.handleBeforeCompact({
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore ?? 0,
      });
    }

    const archiveId = await sync.commit();
    compacted = true;

    // Cache archive overview for rehydration after compaction
    if (archiveId && sync.sessionId) {
      archiveOverview = await fetchArchiveOverview(
        client, sync.sessionId, config,
      );
    }
    // Return nothing → pi proceeds with default compaction
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!connected || bypassed) return;

    await sync.shutdown();
    if (config.takeoverEnabled) {
      await takeover.shutdown();
    } else {
      await sync.commit();
    }
  });

  // --- agent_end ---
  pi.on("agent_end", async () => {
    pendingPrompt = "";
    recallBlock = null;
  });

  // ================================================================
  // Commands
  // ================================================================

  pi.registerCommand("viking-capabilities", {
    description: "Show the active OpenViking provider capabilities.",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(provider.capabilitiesSnapshot()), "info"); },
  });
  pi.registerCommand("viking-memory-stats", {
    description: "Show local memory operation statistics.",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(memoryStats.snapshot()), "info"); },
  });

  pi.registerCommand("viking-consolidate", {
    description: "Scan the local memory ledger for duplicate/contradicting memories and promote findings to review.",
    handler: async (_args, ctx) => {
      const result = await runConsolidationPass(requestContextValue.identity, ctx.ui);
      const lines = result.findings.length
        ? result.findings.map((f) => `sim=${f.similarity.toFixed(2)} ${f.suggestion} | ${f.a.record.content.slice(0, 80)} <-> ${f.b.record.content.slice(0, 80)}`).join("\n")
        : "No similar/contradicting memories found.";
      ctx.ui.notify(`Consolidation: ${result.promoted} promoted, ${result.findings.length} findings.\n${lines}`);
    },
  });

  pi.registerCommand("viking-memory-audit", {
    description: "Show a redacted session audit summary.",
    handler: async (_args, ctx) => { ctx.ui.notify(auditReceipt(sync.sessionId || "none", requestContextValue.identity, recentAuditRecords(sync.sessionId || "none")), "info"); },
  });

  pi.registerCommand("viking", {
    description: "OpenViking status and manual operations. Use 'commit' to force a sync.",
    handler: async (args, ctx) => {
      if (!connected) {
        ctx.ui.notify("OpenViking: not connected", "warning");
        return;
      }

      if (args?.trim() === "commit") {
        await sync.shutdown();
        const commitResult = config.takeoverEnabled ? null : await sync.commit();
        const ok = config.takeoverEnabled
          ? await takeover.commitAndAdvance()
          : commitResult !== null;
        if (ok) {
          ctx.ui.notify(
            "OpenViking: committed successfully" +
              (commitResult?.trace_id ? ` (trace_id=${commitResult.trace_id})` : ""),
            "info",
          );
        } else {
          ctx.ui.notify("OpenViking: commit failed", "error");
        }
        return;
      }

      // Status
      const sid = sync.sessionId ?? "none";
      const t = takeover.state;
      const takeoverInfo = config.takeoverEnabled
        ? ` | takeover: ${t.coveredUserTurns}/${t.lastSeenUserTurns} turns archived, ~${t.pendingTokens} tokens pending`
        : "";
      ctx.ui.notify(
        `OpenViking: ${connected ? "connected" : "disconnected"} | provider=${provider.id} | session: ${sid.slice(0, 12)}...${takeoverInfo}`,
        "info",
      );
    },
  });
}

// ================================================================
// Helper Functions
// ================================================================

/** Simple bypass pattern matching (prefix and glob). */
function matchBypass(cwd: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    return cwd.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return cwd.startsWith(pattern.slice(0, -1));
  }
  return cwd === pattern || cwd.startsWith(pattern + "/");
}

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: any, options?: any) => client.fetchJSON(path, init, 10000),
      config.profileTokenBudget,
      config.peerId,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

/** Fetch archive overview for rehydration using the session context API. */
async function fetchArchiveOverview(
  client: OVClient, sessionId: string, config: OVConfig,
): Promise<string> {
  try {
    const ctx = await client.getSessionContext(sessionId, config.resumeContextBudget);
    if (!ctx || !ctx.latest_archive_overview) return "";

    return [
      '<openviking-context source="session-archive">',
      "<session-archive>",
      ctx.latest_archive_overview,
      "</session-archive>",
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}

function updateStatus(
  ctx: any,
  connected: boolean,
  added: number,
  sessionId: string | null,
  config: OVConfig,
  takeoverState?: { pendingTokens?: number; coveredUserTurns?: number },
): void {
  const setter = ctx?.ui?.setStatus;
  if (typeof setter !== "function") return;
  const threshold = config.takeoverEnabled
    ? config.takeoverTokenThreshold
    : config.commitTokenThreshold;
  const pending = config.takeoverEnabled && takeoverState
    ? ` · ctx ${takeoverState.coveredUserTurns ?? 0} · ~${takeoverState.pendingTokens ?? 0}/${threshold}`
    : ` · ✎ ${threshold}`;
  const status = `${connected ? "OV ✓" : "OV ✗"} · ↩${added}${pending} · ${sessionId ? sessionId.slice(0, 12) : "none"}`;
  try {
    setter(status);
  } catch {
    // Best effort; pi API shape may vary across fast-moving versions.
  }
}
