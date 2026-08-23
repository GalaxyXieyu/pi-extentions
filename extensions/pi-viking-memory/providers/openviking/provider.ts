import { formatRecall } from "../../core/format.js";
import type { CaptureResult, MemoryCapabilities, MemoryItem, MemoryMessage, MemoryProvider, RecallRequest, RecallResult } from "../../core/provider.js";
import type { OVClient, OVSearchResult } from "./client.js";
import type { OVConfig } from "./config.js";
import { replayPending } from "./shared/pending-queue.mjs";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";

export class OpenVikingProvider implements MemoryProvider {
  readonly id = "openviking" as const;
  readonly capabilities: MemoryCapabilities = {
    automaticRecall: true,
    sessionCapture: true,
    semanticSearch: true,
    explicitRemember: true,
    profileWrite: false,
    resourceIngest: false,
    uriRead: false,
    contextTakeover: false,
    archiveExpand: false,
  };

  private readonly client: OVClient;
  private readonly config: OVConfig;
  readonly nativeCapabilities = {
    resourceIngest: true,
    uriRead: true,
    contextTakeover: true,
    archiveExpand: true,
  };

  constructor(client: OVClient, config: OVConfig) {
    this.client = client;
    this.config = config;
  }

  health(): Promise<boolean> { return this.client.health(); }

  async ensureSession(sessionId: string): Promise<boolean> {
    return this.client.createSession(sessionId);
  }

  async replayPending() {
    return replayPending(
      (path: string, init?: any) => this.client.fetchJSON(path, init, 10000),
      () => {},
    );
  }

  async probeCapabilities() {
    const verified = await this.client.health();
    return { backend: this.id, capabilities: { ...this.capabilities }, verified, unsupported: this.capabilities.profileWrite ? [] : ["profileWrite"] };
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const context = await this.client.searchContext(request.query, {
      sessionId: request.sessionId,
      maxTokens: Math.max(500, Math.floor((request.maxChars ?? 6400) / 4)),
      purpose: request.purpose ?? "coding",
      limit: request.limit ?? this.config.recallLimit,
    });
    const items = contextItems(context);
    return { backend: this.id, items, block: formatRecall({ backend: this.id, items, maxChars: request.maxChars }), raw: context };
  }

  async capture(sessionId: string, messages: MemoryMessage[]): Promise<CaptureResult> {
    let count = 0;
    for (const message of messages) {
      const safeContent = sanitizeSensitiveText(message.content);
      const safeParts = message.parts?.map((part) => sanitizeSensitiveValue(part));
      const ok = safeParts?.length
        ? await this.client.addMessageParts(sessionId, message.role, safeParts)
        : await this.client.addMessage(sessionId, message.role, safeContent);
      if (!ok) return { accepted: false, count, backend: this.id, error: "message capture failed" };
      count++;
    }
    return { accepted: true, count, backend: this.id };
  }

  async commit(sessionId: string): Promise<CaptureResult> {
    const result = await this.client.commitSessionResponse(sessionId);
    return result.result
      ? { accepted: true, count: 0, backend: this.id, raw: result.result }
      : { accepted: false, count: 0, backend: this.id, error: result.error?.message || "commit failed" };
  }

  async search(query: string, options?: { limit?: number }): Promise<MemoryItem[]> {
    const context = await this.client.searchContext(query, { limit: options?.limit ?? this.config.recallLimit });
    return contextItems(context);
  }

  async remember(content: string, options?: { sessionId?: string }): Promise<CaptureResult> {
    if (!options?.sessionId) return { accepted: false, count: 0, backend: this.id, error: "sessionId is required" };
    const safeContent = sanitizeSensitiveText(content);
    const ok = await this.client.addMessage(options.sessionId, "user", `[Remember] ${safeContent}`);
    return { accepted: ok, count: ok ? 1 : 0, backend: this.id, raw: { path: `/api/v1/sessions/${options.sessionId}/messages`, body: { role: "user", content: `[Remember] ${safeContent}` } }, error: ok ? undefined : "message capture failed" };
  }

  async updateProfile(profile: string): Promise<CaptureResult> {
    this.unsupported("direct profile write; use session extraction or OpenViking memory policy");
  }

  capabilitiesSnapshot() {
    return { backend: this.id, capabilities: { ...this.capabilities } };
  }

  unsupported(operation: string): never {
    throw new Error(`Memory backend '${this.id}' does not support '${operation}' through the unified adapter.`);
  }
}

function contextItems(context: any): MemoryItem[] {
  if (!context || typeof context !== "object") return [];
  const all = [
    ...(Array.isArray(context.memories) ? context.memories : []),
    ...(Array.isArray(context.resources) ? context.resources : []),
    ...(Array.isArray(context.skills) ? context.skills : []),
  ];
  if (all.length > 0) return all.map(toMemoryItem);
  if (typeof context.rendered === "string" && context.rendered.trim()) {
    return [{ kind: "event", content: context.rendered.trim(), source: "openviking-context", metadata: { assembled: true } }];
  }
  return [];
}

function toMemoryItem(item: OVSearchResult): MemoryItem {
  return {
    kind: item.context_type === "skill" ? "workflow" : item.context_type === "resource" ? "resource" : "event",
    content: item.abstract || item.overview || item.uri,
    id: item.uri,
    score: item.score,
    source: item.uri,
    scope: item.category || undefined,
    metadata: { level: item.level, match_reason: item.match_reason },
  };
}
