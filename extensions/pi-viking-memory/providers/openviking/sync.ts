import type { OVClient } from "./client.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OVConfig } from "./config.js";
import type { MemoryProvider } from "../../core/provider.js";
import { deriveHarnessSessionId } from "./shared/session-model.mjs";
import { enqueue, listPending, replayPending } from "./shared/pending-queue.mjs";
import { extractBranchCapturePayloads } from "./lib/capture-adapter.mjs";
import { countUndeliveredForSession, estimatePayloadTokens } from "./lib/takeover-core.mjs";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";
import type { MemoryRequestContext } from "../../core/contracts.js";

// --- SyncManager ---

export interface AddPayloadResult {
  accepted: boolean;
  delivered: boolean;
}

export interface SyncBranchResult {
  added: number;
  tokens: number;
  allDelivered: boolean;
}

function debugLog(message: string): void {
  const file = process.env.OV_DEBUG_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best effort; logging must never affect pi.
  }
}

export class SyncManager {
  private client: OVClient;
  private config: OVConfig;
  private provider: MemoryProvider;
  private ovSessionId: string | null = null;
  private syncedEntryCount = 0;

  constructor(client: OVClient, config: OVConfig, provider?: MemoryProvider) {
    this.client = client;
    this.config = config;
    this.provider = provider ?? {
      id: "openviking",
      capabilities: {} as any,
      health: () => client.health(),
      recall: async () => ({ backend: "openviking", items: [], block: null }),
      capture: async (sessionId, messages) => {
        let count = 0;
        let delivered = true;
        for (const message of messages) {
          const payload = message.parts?.length
            ? { role: message.role, parts: message.parts }
            : { role: message.role, content: message.content };
          const ok = await client.addMessagePayload
            ? await client.addMessagePayload(sessionId, payload)
            : await client.addMessage(sessionId, message.role, message.content);
          if (!ok) {
            await enqueue("addMessage", sessionId, payload);
            delivered = false;
            count++;
            continue;
          }
          count++;
        }
        return { accepted: true, count, delivered, backend: "openviking" };
      },
      commit: async (sessionId) => {
        const response = await client.commitSessionResponse(sessionId);
        const result = response?.result;
        if (result) return { accepted: true, count: 0, backend: "openviking", raw: result };
        return { accepted: false, count: 0, backend: "openviking", error: response?.error?.message || "commit failed", raw: response?.traceId ? { trace_id: response.traceId } : undefined };
      },
      search: async () => [],
      remember: async () => ({ accepted: false, count: 0, backend: "openviking", error: "unsupported" }),
      updateProfile: async () => ({ accepted: false, count: 0, backend: "openviking", error: "unsupported" }),
      capabilitiesSnapshot: () => ({ backend: "openviking", capabilities: {} as any }),
      unsupported: (operation: string): never => { throw new Error(operation); },
    };
  }

  get sessionId(): string | null { return this.ovSessionId; }
  get syncedCount(): number { return this.syncedEntryCount; }

  restoreWatermark(n: number): void {
    const next = Math.max(0, Math.floor(Number(n) || 0));
    this.syncedEntryCount = next;
  }

  async ensureSession(piSessionId: string): Promise<boolean> {
    if (this.ovSessionId) return true;

    const id = deriveHarnessSessionId("pi-", piSessionId);
    const created = this.provider.ensureSession
      ? await this.provider.ensureSession(id)
      : await this.client.createSession(id);
    if (!created) return false;
    this.ovSessionId = id;
    return true;
  }

  async replayPending(): Promise<void> {
    if (!this.client.connected) return;
    await replayPending(
      (path: string, init?: any) => this.client.fetchJSON(path, init, 10000),
      (stage: string, data: unknown) =>
        debugLog(`${sanitizeSensitiveText(stage)}: ${JSON.stringify(sanitizeSensitiveValue(data))}`),
    );
  }

  async flushForTakeover(): Promise<boolean> {
    if (!this.ovSessionId) return false;
    await this.replayPending();
    const pending = await listPending();
    return countUndeliveredForSession(pending, this.ovSessionId) === 0;
  }

  async syncBranch(branch: any[], context?: MemoryRequestContext): Promise<SyncBranchResult> {
    if (!this.ovSessionId) return { added: 0, tokens: 0, allDelivered: true };

    const extracted = extractBranchCapturePayloads(branch, this.syncedEntryCount, this.config);
    if (extracted.resetWatermark) this.syncedEntryCount = 0;
    const messages = extracted.payloads.map((payload: any) => ({
      role: payload.role === "assistant" ? "assistant" : "user",
      content: typeof payload.content === "string" ? payload.content : "",
      parts: Array.isArray(payload.parts) ? payload.parts : undefined,
    }));
    const captured = await this.provider.capture(this.ovSessionId, messages, context);
    const added = captured.count;
    const tokens = extracted.payloads.slice(0, added).reduce((sum, payload) => sum + estimatePayloadTokens(payload), 0);
    const allDelivered = captured.accepted && captured.delivered !== false;
    if (captured.accepted) this.syncedEntryCount = extracted.nextEntryCount;
    if (added > 0 && !this.config.takeoverEnabled) {
      await this.commitIfNeeded();
    }
    return { added, tokens, allDelivered };
  }

  async addPayload(payload: any): Promise<AddPayloadResult> {
    if (!this.ovSessionId) return { accepted: false, delivered: false };
    const ok = await this.client.addMessagePayload(this.ovSessionId, payload);
    if (ok) return { accepted: true, delivered: true };
    await enqueue("addMessage", this.ovSessionId, payload);
    return { accepted: true, delivered: false };
  }

  async commitIfNeeded(): Promise<void> {
    if (!this.ovSessionId) return;
    const meta = await this.client.getSession(this.ovSessionId);
    const pending = Number(meta?.pending_tokens || 0);
    if (pending >= this.config.commitTokenThreshold) {
      await this.commit();
    }
  }

  async commit(opts: { queueOnFailure?: boolean; keepRecentCount?: number } = {}): Promise<any | null> {
    if (!this.ovSessionId) return null;
    const result = this.provider.commit ? await this.provider.commit(this.ovSessionId) : null;
    if (!result?.accepted) {
      debugLog(
        `commit: session=${sanitizeSensitiveText(this.ovSessionId)} ok=false ` +
          `trace_id=${(result?.raw as any)?.trace_id || "none"} ` +
          `error=${result?.error || "provider commit unavailable"}`,
      );
      if (opts.queueOnFailure !== false) {
        await enqueue("commitSession", this.ovSessionId, {
          keep_recent_count: opts.keepRecentCount ?? this.config.commitKeepRecentCount,
        });
      }
      return null;
    }
    debugLog(`commit: session=${sanitizeSensitiveText(this.ovSessionId)} ok=true trace_id=${sanitizeSensitiveText((result.raw as any)?.trace_id || "none")}`);
    return result.raw;
  }

  async shutdown(): Promise<void> {
    return;
  }
}
