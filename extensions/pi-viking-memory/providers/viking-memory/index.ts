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

export default async function (pi: ExtensionAPI) {
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled || !isSelected("viking-memory")) return;

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

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      conversationId = normalizeId(ctx?.sessionManager?.getSessionId?.() || `pi_${Date.now()}`);
      connected = await client.health();
      if (!connected) {
        log("remote Viking Memory is not reachable or credentials are invalid");
        return;
      }
      if (!toolsRegistered) {
        registerTools(pi, provider, config, () => conversationId);
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
    pendingPrompt = String(event?.prompt || "");
  });

  pi.on("context", async (event: any) => {
    if (!connected || pendingPrompt.trim().length < config.minQueryLength) return;
    const query = pendingPrompt;
    pendingPrompt = "";
    const result = await provider.recall({
      query,
      sessionId: conversationId,
      purpose: "coding",
      limit: config.recallLimit,
      maxChars: config.recallTokenBudget * 4,
    });
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
    const result = await provider.capture(conversationId, extracted.messages);
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
    const result = await provider.capture(`${conversationId}_shutdown`, extracted.messages);
    if (!result.accepted) log(`shutdown session/add failed: ${result.error || "no response"}`);
    else syncedEntryCount = extracted.nextEntryCount;
  });

  pi.on("agent_end", async () => { recallBlock = null; pendingPrompt = ""; });

  pi.registerCommand("viking-memory-capabilities", {
    description: "Show the active memory backend capabilities.",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(JSON.stringify(provider.capabilitiesSnapshot()), "info");
    },
  });

  pi.registerCommand("viking-memory", {
    description: "Remote Viking Memory status; use 'search <query>' to search memories.",
    handler: async (args: string, ctx: any) => {
      if (args.trim().startsWith("search ")) {
        const items = await provider.search(args.trim().slice(7), { limit: config.recallLimit });
        ctx.ui.notify(items.length ? JSON.stringify(items) : "No results found.", "info");
        return;
      }
      ctx.ui.notify(`Viking Memory: ${connected ? "connected" : "disconnected"} | collection=${config.collectionName} | project=${config.projectName} | conversation=${conversationId || "none"}`, connected ? "info" : "warning");
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
