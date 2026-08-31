import type { VikingMemoryConfig } from "./config.js";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GLOBAL_MEMORY_GROUP } from "../../core/workspace-identity.js";

export interface VikingResponse<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
  request_id?: string;
}

export interface VikingContext {
  [key: string]: unknown;
}

export interface VikingMessage {
  role: "user" | "assistant";
  content: string;
  time?: number;
}

function mergeSearchData(...sources: Array<unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (Array.isArray(value)) merged[key] = [...(Array.isArray(merged[key]) ? merged[key] as unknown[] : []), ...value];
      else if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

export class VikingMemoryClient {
  private readonly baseUrl: string;
  private readonly config: VikingMemoryConfig;
  connected = false;
  private readonly debugLog = process.env.VIKING_MEMORY_DEBUG_LOG || "";

  constructor(config: VikingMemoryConfig) {
    this.config = config;
    this.baseUrl = config.endpoint.replace(/\/+$/, "");
  }

  async getContext(conversationId: string, query: string, options: { scoreThreshold?: number; timeDecayWeight?: number; noDecayPeriod?: number } = {}): Promise<VikingResponse<VikingContext> | null> {
    return this.post<VikingContext>("/api/memory/get_context", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      conversation_id: conversationId,
      query,
      event_search_config: {
        filter: this.filter(["event_v1"], this.config.groupId),
        limit: this.config.recallLimit,
        ...(typeof options.scoreThreshold === "number" ? { score_threshold: options.scoreThreshold } : {}),
        time_decay_config: { weight: options.timeDecayWeight ?? 0.5, no_decay_period: options.noDecayPeriod ?? 3 },
      },
      profile_search_config: {
        // User preferences are deliberately global so they travel with the user.
        filter: this.filter(["profile_v1"], GLOBAL_MEMORY_GROUP),
        limit: 1,
      },
    });
  }

  async addSession(sessionId: string, messages: VikingMessage[], options?: { ttlRelativeSeconds?: number; ttlAbsoluteMs?: number }): Promise<VikingResponse | null> {
    if (messages.length === 0) return null;
    return this.post("/api/memory/session/add", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      session_id: sessionId,
      messages,
      ...(options?.ttlRelativeSeconds ? { ttl_relative: options.ttlRelativeSeconds } : {}),
      ...(options?.ttlAbsoluteMs ? { ttl_absolute: options.ttlAbsoluteMs } : {}),
      metadata: {
        default_user_id: this.config.userId,
        default_assistant_id: this.config.assistantId,
        ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
        time: Date.now(),
      },
    });
  }

  async search(query: string, limit = this.config.recallLimit): Promise<VikingResponse | null> {
    // Manual search mirrors automatic recall: current-project events plus
    // user-global profiles, never another project's event stream.
    const [events, profiles] = await Promise.all([
      this.searchGroup(query, limit, ["event_v1"], this.config.groupId),
      this.searchGroup(query, limit, ["profile_v1"], GLOBAL_MEMORY_GROUP),
    ]);
    if (!events && !profiles) return null;
    if (events?.code !== 0 && profiles?.code !== 0) return events || profiles;
    return {
      code: 0,
      message: "success",
      request_id: events?.request_id || profiles?.request_id,
      data: mergeSearchData(events?.data, profiles?.data),
    };
  }

  private async searchGroup(query: string, limit: number, memoryType: string[], groupId: string): Promise<VikingResponse | null> {
    return this.post("/api/memory/search", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      query,
      limit,
      filter: this.filter(memoryType, groupId),
    });
  }

  async addEvent(summary: string, sessionId?: string): Promise<VikingResponse | null> {
    return this.post("/api/memory/event/add", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      event_type: "event_v1",
      memory_info: { summary },
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
    });
  }

  async updateEvent(eventId: string, summary: string): Promise<VikingResponse | null> {
    return this.post("/api/memory/event/update", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      event_id: eventId,
      event_type: "event_v1",
      memory_info: { summary },
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
    });
  }

  async updateProfile(profileId: string, userProfile: string): Promise<VikingResponse | null> {
    return this.post("/api/memory/profile/update", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      profile_id: profileId,
      profile_type: "profile_v1",
      memory_info: { user_profile: userProfile },
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      group_id: GLOBAL_MEMORY_GROUP,
    });
  }

  async collectionInfo(): Promise<VikingResponse | null> {
    return this.post("/api/memory/collection/info", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
    });
  }

  async addProfile(profile: string): Promise<VikingResponse | null> {
    return this.post("/api/memory/profile/add", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      profile_type: "profile_v1",
      memory_info: { user_profile: profile },
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      is_upsert: true,
      group_id: GLOBAL_MEMORY_GROUP,
    });
  }

  async health(): Promise<boolean> {
    const response = await this.search("__pi_viking_memory_health_check__", 1);
    this.connected = response?.code === 0;
    return this.connected;
  }

  private filter(memoryType: string[], groupId = this.config.groupId): Record<string, unknown> {
    return {
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      memory_type: memoryType,
      ...(groupId ? { group_id: groupId } : {}),
    };
  }

  private async post<T = unknown>(path: string, payload: unknown, timeoutMs = 15000): Promise<VikingResponse<T> | null> {
    if (!this.config.apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.code !== 0) {
        this.log("http_error", { path, status: response.status, error: sanitizeSensitiveValue(body?.message || body?.error) });
        return body as VikingResponse<T>;
      }
      return body as VikingResponse<T>;
    } catch (error: any) {
      this.log("request_error", { path, code: error?.name === "AbortError" ? "timeout" : "network_error", error: sanitizeSensitiveText(error?.message || String(error)) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private log(stage: string, data: unknown): void {
    if (!this.debugLog) return;
    try {
      mkdirSync(dirname(this.debugLog), { recursive: true });
      appendFileSync(this.debugLog, JSON.stringify({ stage, data: sanitizeSensitiveValue(data) }) + "\n");
    } catch {
      // Logging must never affect the Pi session.
    }
  }
}
