import { formatRecall } from "../../core/format.js";
import type { CaptureResult, MemoryCapabilities, MemoryItem, MemoryProvider, RecallRequest, RecallResult } from "../../core/provider.js";
import type { VikingMemoryClient, VikingResponse } from "./client.js";
import type { VikingMemoryConfig } from "./config.js";
import { buildRecallBlock } from "./recall.js";
import { sanitizeSensitiveText } from "../../core/sensitive.mjs";

export class VikingMemoryProvider implements MemoryProvider {
  readonly id = "viking-memory" as const;
  readonly capabilities: MemoryCapabilities = {
    automaticRecall: true,
    sessionCapture: true,
    semanticSearch: true,
    explicitRemember: true,
    profileWrite: true,
    resourceIngest: false,
    uriRead: false,
    contextTakeover: false,
    archiveExpand: false,
  };

  private readonly client: VikingMemoryClient;
  private readonly config: VikingMemoryConfig;

  constructor(client: VikingMemoryClient, config: VikingMemoryConfig) {
    this.client = client;
    this.config = config;
  }

  health(): Promise<boolean> { return this.client.health(); }

  async probeCapabilities() {
    const verified = await this.client.health();
    return { backend: this.id, capabilities: { ...this.capabilities }, verified, unsupported: ["resourceIngest", "uriRead", "contextTakeover", "archiveExpand"] };
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const response = await this.client.getContext(request.sessionId || `pi_${Date.now()}`, request.query);
    if (!response || response.code !== 0) return { backend: this.id, items: [], block: null, raw: response };
    const context = response.data ?? null;
    const items = contextItems(context);
    return {
      backend: this.id,
      items,
      block: formatRecall({ backend: this.id, items, maxChars: request.maxChars }),
      raw: response,
    };
  }

  async capture(sessionId: string, messages: import("../../core/provider.js").MemoryMessage[]): Promise<CaptureResult> {
    const response = await this.client.addSession(`${sessionId}_${Date.now()}`, messages);
    return responseResult(this.id, response, messages.length);
  }

  async search(query: string, options?: { limit?: number; kind?: string }): Promise<MemoryItem[]> {
    const response = await this.client.search(query, options?.limit ?? this.config.recallLimit);
    return response?.code === 0 ? contextItems(response.data) : [];
  }

  async remember(content: string, options?: { kind?: string; sessionId?: string }): Promise<CaptureResult> {
    const response = await this.client.addEvent(sanitizeSensitiveText(content), options?.sessionId);
    return responseResult(this.id, response, 1);
  }

  async updateProfile(profile: string): Promise<CaptureResult> {
    return responseResult(this.id, await this.client.addProfile(sanitizeSensitiveText(profile)), 1);
  }

  capabilitiesSnapshot() {
    return { backend: this.id, capabilities: { ...this.capabilities } };
  }

  unsupported(operation: string): never {
    throw new Error(`Memory backend '${this.id}' does not support '${operation}'.`);
  }
}

function contextItems(value: any): MemoryItem[] {
  if (!value || typeof value !== "object") return [];
  const result: MemoryItem[] = [];
  for (const [kind, keys] of Object.entries({
    profile: ["profile_memory", "profile_memories", "profiles", "profile"],
    event: ["event_memory", "event_memories", "events", "event"],
    session: ["messages", "short_term_memory", "conversation"],
  })) {
    for (const key of keys) {
      const items = Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : [];
      for (const item of items) {
        const content = item?.memory_info?.user_profile || item?.memory_info?.summary || item?.content || item?.text || (typeof item === "string" ? item : JSON.stringify(item));
        if (content) result.push({ kind, content: String(content), id: item?.id || item?.event_id || item?.profile_id, score: item?.score, source: "viking-memory", scope: item?.session_id });
      }
      if (items.length) break;
    }
  }
  return result;
}

function responseResult(backend: "viking-memory", response: VikingResponse | null, count: number): CaptureResult {
  return response?.code === 0
    ? { accepted: true, count, backend, raw: response }
    : { accepted: false, count: 0, backend, raw: response, error: response?.message || "request failed" };
}
