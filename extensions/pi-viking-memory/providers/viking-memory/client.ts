import type { VikingMemoryConfig } from "./config.js";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export class VikingMemoryClient {
  private readonly baseUrl: string;
  private readonly config: VikingMemoryConfig;
  connected = false;
  private readonly debugLog = process.env.VIKING_MEMORY_DEBUG_LOG || "";

  constructor(config: VikingMemoryConfig) {
    this.config = config;
    this.baseUrl = config.endpoint.replace(/\/+$/, "");
  }

  async getContext(conversationId: string, query: string): Promise<VikingResponse<VikingContext> | null> {
    return this.post<VikingContext>("/api/memory/get_context", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      conversation_id: conversationId,
      query,
      event_search_config: {
        filter: this.filter(["event_v1"]),
        limit: this.config.recallLimit,
        time_decay_config: { weight: 0.5, no_decay_period: 3 },
      },
      profile_search_config: {
        filter: this.filter(["profile_v1"]),
        limit: 1,
      },
    });
  }

  async addSession(sessionId: string, messages: VikingMessage[]): Promise<VikingResponse | null> {
    if (messages.length === 0) return null;
    return this.post("/api/memory/session/add", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      session_id: sessionId,
      messages,
      metadata: {
        default_user_id: this.config.userId,
        default_assistant_id: this.config.assistantId,
        ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
        time: Date.now(),
      },
    });
  }

  async search(query: string, limit = this.config.recallLimit): Promise<VikingResponse | null> {
    return this.post("/api/memory/search", {
      collection_name: this.config.collectionName,
      project_name: this.config.projectName,
      query,
      limit,
      filter: this.filter(["event_v1", "profile_v1"]),
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
      ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
    });
  }

  async health(): Promise<boolean> {
    const response = await this.search("__pi_viking_memory_health_check__", 1);
    this.connected = response?.code === 0;
    return this.connected;
  }

  private filter(memoryType: string[]): Record<string, unknown> {
    return {
      user_id: this.config.userId,
      assistant_id: this.config.assistantId,
      memory_type: memoryType,
      ...(this.config.groupId ? { group_id: this.config.groupId } : {}),
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
