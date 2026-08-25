import { formatRecall } from "../../core/format.js";
import type { CaptureResult, MemoryCapabilities, MemoryItem, MemoryProvider, RecallRequest, RecallResult } from "../../core/provider.js";
import type { VikingMemoryClient, VikingResponse } from "./client.js";
import type { VikingMemoryConfig } from "./config.js";
import { buildRecallBlock } from "./recall.js";
import { sanitizeSensitiveText } from "../../core/sensitive.mjs";
import { extractCandidates } from "../../core/candidate-extractor.js";
import { localIdentity } from "../../core/contracts.js";
import { scanMemoryContent } from "../../core/content-scanner.js";
import { authorize, curateWithLlm, filterRecall, gateCapture, persistLifecycleRecord, persistLifecycleTransition, backfillLifecycleRemoteId, memoryHistoryById } from "../../core/runtime.js";
import { llmExtractionEnabled } from "../../core/llm-extractor.js";
import type { LlmCompleteFn } from "../../core/llm-extractor.js";
import { lifecycleFingerprint } from "../../core/lifecycle-store.js";
import { rerankRecall } from "../../core/recall-rerank.js";
import { CurationQueue } from "../../core/curation-queue.js";
import type { MemoryRequestContext, MemoryRecord } from "../../core/contracts.js";

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
  private readonly curationQueue = new CurationQueue();
  private pilotComplete: LlmCompleteFn | null = null;

  /** Inherit pi's provider/auth for the LLM funnel (zero standalone config). */
  setPilotComplete(complete: LlmCompleteFn | null): void {
    this.pilotComplete = complete;
  }

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
    const sessionId = request.sessionId || `pi_${Date.now()}`;
    const userId = request.context?.identity.userId || this.config.userId;
    const groupId = request.context?.identity.workspaceId || this.config.groupId;
    const tenantId = request.context?.identity.tenantId || "local";

    // Primary: get_context (short-term context + service-assembled parts ... but
    // the server may cut the events bucket. Merge the full /api/memory/search
    // hits below so truncated memories still reach the model.
    const response = await this.client.getContext(sessionId, request.query, { scoreThreshold: this.config.scoreThreshold });
    let items: MemoryItem[] = response && response.code === 0
      ? contextItems(flattenContextParts(response.data ?? null), userId, groupId, tenantId)
      : [];

    try {
      const searchRes = await this.client.search(request.query, this.config.recallLimit);
      if (searchRes?.code === 0) {
        const extra = contextItems(flattenContextParts(searchRes.data), userId, groupId, tenantId);
        items = mergeItems(items, extra);
      }
    } catch {
      // recall must never break the turn; get_context rows already covered us
    }

    const filtered = request.context ? filterRecall(items, request.context) : { items, dropped: 0 };
    const reranked = rerankRecall(filtered.items, request.query);
    const historyById = request.context?.identity ? memoryHistoryById(request.context.identity) : new Map<string, string[]>();
    return {
      backend: this.id,
      purpose: request.purpose || "coding",
      items: reranked,
      block: formatRecall({ backend: this.id, items: reranked, maxChars: request.maxChars, purpose: request.purpose || "coding" } as any, { historyById }),
      raw: response,
    };
  }

  async capture(sessionId: string, messages: import("../../core/provider.js").MemoryMessage[], context?: MemoryRequestContext): Promise<CaptureResult> {
    const decisions: Array<{ decision: string; reason: string; kind?: string }> = [];
    const conflicts: Array<{ fingerprint?: string; kind: string; candidate: string; targetId?: string; targetContent?: string }> = [];
    const sessionMessages: import("../../core/provider.js").MemoryMessage[] = [];
    const createdCandidates: Array<import("../../core/contracts.js").MemoryRecord> = [];
    let rejected = 0;
    let lifecycleWrites = 0;

    for (const message of messages) {
      if (!context) {
        sessionMessages.push(message);
        continue;
      }
      const preScan = scanMemoryContent(message.content);
      if (preScan.action === "reject" || preScan.action === "threat") { rejected++; continue; }
      const ruleCandidates = extractCandidates({ text: message.content, identity: context.identity, purpose: context.purpose, sourceType: message.role === "assistant" ? "agent" : "user", sessionId, policyVersion: context.policyVersion });
      const ruleHit = ruleCandidates.candidates.length > 0;

      if (ruleHit) {
      const gate = await gateCapture(message.content, context.identity, context, async (query) => {
        const response = await this.client.search(query, this.config.recallLimit);
        const items = response?.code === 0 ? contextItems(response.data, context.identity.userId, context.identity.workspaceId || this.config.groupId, context.identity.tenantId) : [];
        return filterRecall(items, context).items;
      }, message.role === "assistant" ? "agent" : "user");
      const decision = gate.lifecycle?.decision || "capture-only";
      if (decision === "create" && gate.extraction.candidates[0]) createdCandidates.push(gate.extraction.candidates[0] as unknown as import("../../core/contracts.js").MemoryRecord);
      decisions.push({ decision, reason: gate.reason, kind: gate.extraction.candidates[0]?.kind });

      if (gate.lifecycle?.decision === "conflict") {
        const conflictRecord = gate.extraction.candidates[0];
        conflicts.push({
          fingerprint: conflictRecord ? lifecycleFingerprint(conflictRecord) : undefined,
          kind: String(conflictRecord?.kind || ""),
          candidate: String(conflictRecord?.summary || conflictRecord?.content || message.content || "").slice(0, 300),
          targetId: gate.lifecycle?.target?.id,
          targetContent: String(gate.lifecycle?.target?.content || "").slice(0, 300),
        });
      }

      if (!gate.allowed && gate.writeMode !== "lifecycle-action") {
        rejected++;
        continue;
      }

      if (gate.writeMode === "session" && decision === "create" && gate.extraction.candidates[0]) {
        const candidate = gate.extraction.candidates[0] as unknown as import("../../core/contracts.js").MemoryRecord;
        const summary = candidate.summary || sanitizeSensitiveText(message.content);
        const response = isGlobalPreference(candidate.kind)
          ? await this.client.addProfile(sanitizeSensitiveText(summary))
          : await this.client.addEvent(sanitizeSensitiveText(summary), sessionId);
        if (response?.code === 0) {
          const remoteId = response?.data?.event_id || response?.data?.profile_id || response?.data?.id;
          if (remoteId) persistLifecycleRecord({ ...candidate, status: "active" as const }, remoteId, "remote-create");
          lifecycleWrites++;
          continue;
        }
        // fall through to session path when the durable write is not supported
        sessionMessages.push({ ...message, metadata: { ...(message.metadata || {}), tenant_id: context.identity.tenantId, user_id: context.identity.userId, assistant_id: context.identity.agentId, workspace_id: context.identity.workspaceId, policy_version: context.policyVersion, request_id: context.requestId, lifecycle_decision: decision } });
        continue;
      }

      if (gate.writeMode === "lifecycle-action") {
        const target = gate.lifecycle?.target;
        const targetId = target?.id;
        const candidate = gate.extraction.candidates[0] as unknown as MemoryRecord | undefined;
        const content = gate.lifecycle?.decision === "merge" && target ? `${target.content}\n\n${candidate?.summary || message.content}` : (candidate?.summary || sanitizeSensitiveText(message.content));
        const updated = targetId
          ? isGlobalPreference(candidate?.kind)
            ? await this.client.updateProfile(targetId, content)
            : await this.client.updateEvent(targetId, content)
          : null;
        if (!updated || updated.code !== 0 || !candidate || !target) {
          return { accepted: false, count: lifecycleWrites, rejected, candidates: gate.extraction.candidates.length, decisions, conflicts, backend: this.id, error: "lifecycle-action-deferred:no-updatable-remote-record", raw: gate };
        }
        const next = { ...candidate, content, status: "active" as const, supersedes: target.id ? [target.id] : [] };
        persistLifecycleTransition(target, "superseded", `remote-${gate.lifecycle?.decision}`, target.id);
        persistLifecycleRecord(next, targetId, `remote-${gate.lifecycle?.decision}`);
        lifecycleWrites++;
        continue;
      }

      sessionMessages.push({
        ...message,
        metadata: {
          ...(message.metadata || {}),
          tenant_id: context.identity.tenantId,
          user_id: context.identity.userId,
          assistant_id: context.identity.agentId,
          workspace_id: context.identity.workspaceId,
          policy_version: context.policyVersion,
          request_id: context.requestId,
          lifecycle_decision: decision,
        },
      });
      } else {
        // Rule-miss long tail: queue for batch LLM curation (opt-in). Message
        // still goes into the cloud session below — backend extraction is the
        // final safety net.
        this.curationQueue.enqueue({ role: message.role, content: message.content });
        sessionMessages.push({
          ...message,
          metadata: context ? {
            ...(message.metadata || {}),
            tenant_id: context.identity.tenantId,
            user_id: context.identity.userId,
            assistant_id: context.identity.agentId,
            workspace_id: context.identity.workspaceId,
            policy_version: context.policyVersion,
            request_id: context.requestId,
            lifecycle_decision: "rule-miss",
          } : message.metadata,
        });
      }
    }

    // Batch LLM curation flush for the rule-miss tail.
    if (context && this.curationQueue.shouldFlush()) {
      const flushed = await this.flushCuration(sessionId, context);
      decisions.push(...flushed.decisions);
      rejected += flushed.rejected;
      lifecycleWrites += flushed.count;
    }

    if (sessionMessages.length === 0) return { accepted: rejected === 0, count: lifecycleWrites, rejected, decisions, conflicts, backend: this.id };
    const response = await this.client.addSession(`${sessionId}_${Date.now()}`, sessionMessages);
    if (response?.code === 0 && createdCandidates.length) {
      for (const candidate of createdCandidates) {
        try {
          const search = await this.client.search(candidate.summary, this.config.recallLimit);
          const events = search?.data?.events || [];
          const match = events.find((e: any) => (e.id || e.event_id) && (e?.memory_info?.summary || e?.summary || e?.content || "").includes(candidate.summary.slice(0, 24)));
          if (match) backfillLifecycleRemoteId(candidate, match.id || match.event_id);
        } catch { /* best-effort backfill */ }
      }
    }
    return { ...responseResult(this.id, response, lifecycleWrites + sessionMessages.length), decisions, conflicts, rejected: response?.code === 0 ? rejected : rejected + sessionMessages.length };
  }

  /** Flush queued rule-miss messages through the batch LLM curator (opt-in). */
  async flushCuration(sessionId: string, context: MemoryRequestContext): Promise<{ count: number; rejected: number; decisions: Array<{ decision: string; reason: string; kind?: string }> }> {
    const decisions: Array<{ decision: string; reason: string; kind?: string }> = [];
    if (!llmExtractionEnabled() || this.curationQueue.size === 0) return { count: 0, rejected: 0, decisions };
    const batch = this.curationQueue.takeBatch();
    if (!batch.length) return { count: 0, rejected: 0, decisions };

    const curated = await curateWithLlm(batch, context.identity, context, async (query) => this.search(query, { limit: this.config.recallLimit, context }), this.pilotComplete ?? undefined);
    if (!curated.handled) {
      this.curationQueue.requeue(batch);
      return { count: 0, rejected: 0, decisions };
    }

    let count = 0;
    let rejected = 0;
    for (const d of curated.decisions) {
      const record = d.candidate;
      if (d.action === "update" && d.target) {
        const targetId = d.target.id;
        const merged = `${d.target.content}\n\nUPDATED: ${record.content}`;
        const updated = targetId
          ? isGlobalPreference(record.kind)
            ? await this.client.updateProfile(targetId, merged)
            : await this.client.updateEvent(targetId, merged)
          : null;
        if (!updated || updated.code !== 0 || !targetId) { rejected++; decisions.push({ decision: "update", reason: "remote-update-failed", kind: record.kind }); continue; }
        persistLifecycleTransition(d.target, "superseded", "llm-update", targetId);
        persistLifecycleRecord({ ...record, status: "active" as const }, targetId, "llm-update");
        count++;
        decisions.push({ decision: "update", reason: d.reason || "llm", kind: record.kind });
      } else if (d.action === "add") {
        const response = isGlobalPreference(record.kind)
          ? await this.client.addProfile(sanitizeSensitiveText(record.content))
          : await this.client.addEvent(sanitizeSensitiveText(record.content), sessionId);
        if (response?.code !== 0) { rejected++; decisions.push({ decision: "add", reason: "remote-create-failed", kind: record.kind }); continue; }
        const remoteId = response?.data?.event_id || response?.data?.profile_id || response?.data?.id;
        if (remoteId) persistLifecycleRecord({ ...record, status: "active" as const }, remoteId, "llm-create");
        count++;
        decisions.push({ decision: "add", reason: d.reason || "llm", kind: record.kind });
      }
    }
    return { count, rejected, decisions };
  }

  async search(query: string, options?: { limit?: number; kind?: string; context?: MemoryRequestContext }): Promise<MemoryItem[]> {
    if (options?.context && !authorize(options.context, "recall").allowed) return [];
    const response = await this.client.search(query, options?.limit ?? this.config.recallLimit);
    const items = response?.code === 0 ? contextItems(response.data, options?.context?.identity.userId || this.config.userId, options?.context?.identity.workspaceId || this.config.groupId, options?.context?.identity.tenantId || "local") : [];
    return options?.context ? filterRecall(items, options.context).items : items;
  }

  async remember(content: string, options?: { kind?: string; sessionId?: string; context?: MemoryRequestContext }): Promise<CaptureResult> {
    const candidate = extractCandidates({ text: content, identity: options?.context?.identity || localIdentity(), purpose: options?.context?.purpose || "coding", sessionId: options?.sessionId, policyVersion: options?.context?.policyVersion });
    if (options?.context && !authorize(options.context, "remember").allowed) return { accepted: false, count: 0, backend: this.id, error: "permission-denied:remember" };
    if (candidate.rejected.length) return { accepted: false, count: 0, backend: this.id, error: `memory candidate rejected: ${candidate.rejected[0].reason}`, raw: candidate };
    const memory = candidate.candidates[0];
    const response = isGlobalPreference(memory?.kind)
      ? await this.client.addProfile(sanitizeSensitiveText(content))
      : await this.client.addEvent(sanitizeSensitiveText(content), options?.sessionId);
    return { ...responseResult(this.id, response, 1), raw: { response, candidate: memory } };
  }

  async updateProfile(profile: string, context?: MemoryRequestContext): Promise<CaptureResult> {
    if (context && !authorize(context, "profile").allowed) return { accepted: false, count: 0, backend: this.id, error: "permission-denied:profile" };
    const candidate = extractCandidates({ text: profile, identity: context?.identity || localIdentity(), purpose: "chat", sessionId: context?.identity.sessionId, policyVersion: context?.policyVersion });
    if (candidate.rejected.length) return { accepted: false, count: 0, backend: this.id, error: `profile candidate rejected: ${candidate.rejected[0].reason}`, raw: candidate };
    return { ...responseResult(this.id, await this.client.addProfile(sanitizeSensitiveText(profile)), 1), raw: { candidate: candidate.candidates[0] } };
  }

  capabilitiesSnapshot() {
    return {
      backend: this.id,
      provider: Object.fromEntries(Object.entries(this.capabilities).map(([key, value]) => [key, value ? "supported" : "unsupported"])),
      native: {},
      verified: this.client.connected,
      checkedAt: new Date().toISOString(),
    };
  }

  unsupported(operation: string): never {
    throw new Error(`Memory backend '${this.id}' does not support '${operation}'.`);
  }
}

function isGlobalPreference(kind: string | undefined): boolean {
  return kind === "profile" || kind === "preference";
}

function normalizeMemoryKind(value: unknown, fallback: string): string {
  if (value === "profile_v1") return "profile";
  if (value === "event_v1") return "event";
  return typeof value === "string" && value ? value : fallback;
}

function firstString(value: unknown, fallback = ""): string {
  if (Array.isArray(value)) return firstString(value[0], fallback);
  return typeof value === "string" && value ? value : fallback;
}

/**
 * get_context returns bucket-shaped `context_parts` (events[] / profiles[] /
 * messages[]), while contextItems understands flat keys. Flatten before parse.
 */
function flattenContextParts(value: any): any {
  if (!value || typeof value !== "object") return value;
  const merged: Record<string, unknown> = { ...value };
  const events: unknown[] = [];
  const profiles: unknown[] = [];
  const messages: unknown[] = [];

  // /api/memory/search returns result_list (flat); get_context returns
  // context_parts buckets. Normalize both shapes into flat keys.
  for (const key of ["result_list", "events", "event", "event_memory", "event_memories"]) {
    if (Array.isArray(value[key])) events.push(...value[key]);
  }
  for (const key of ["profiles", "profile", "profile_memory", "profile_memories"]) {
    if (Array.isArray(value[key])) profiles.push(...value[key]);
  }
  for (const key of ["messages", "short_term_memory", "conversation"]) {
    if (Array.isArray(value[key])) messages.push(...value[key]);
  }

  if (Array.isArray(value.context_parts)) {
    for (const part of value.context_parts) {
      if (!part || typeof part !== "object") continue;
      if (Array.isArray(part.events)) events.push(...part.events);
      if (Array.isArray(part.profiles)) profiles.push(...part.profiles);
      if (Array.isArray(part.profile)) profiles.push(...part.profile);
      if (Array.isArray(part.messages)) messages.push(...part.messages);
      if (Array.isArray(part.short_term_memory)) messages.push(...part.short_term_memory);
    }
  }

  merged.events = events;
  merged.profile = profiles;
  merged.messages = messages;
  return merged;
}

/** Merge two item lists deduping by id (fallback: content), keeping higher scores. */
function mergeItems(base: MemoryItem[], extra: MemoryItem[]): MemoryItem[] {
  if (!extra.length) return base;
  const byKey = new Map<string, MemoryItem>();
  for (const item of [...base, ...extra]) {
    const key = String(item.id || item.content || "").slice(0, 200);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || (item.score ?? 0) > (existing.score ?? 0)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function contextItems(value: any, fallbackUserId = "", fallbackGroupId = "", fallbackTenantId = "local"): MemoryItem[] {
  if (!value || typeof value !== "object") return [];
  const result: MemoryItem[] = [];
  // /api/memory/search returns `result_list`; get_context may return the
  // legacy typed buckets below. Support both shapes.
  const buckets: Record<string, string[]> = {
    profile: ["profile_memory", "profile_memories", "profiles", "profile"],
    event: ["result_list", "event_memory", "event_memories", "events", "event"],
    session: ["messages", "short_term_memory", "conversation"],
  };
  for (const [kind, keys] of Object.entries(buckets)) {
    for (const key of keys) {
      const items = Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : [];
      for (const item of items) {
        const content = item?.memory_info?.user_profile || item?.memory_info?.summary || item?.content || item?.text || (typeof item === "string" ? item : JSON.stringify(item));
        if (content) result.push({
          kind: normalizeMemoryKind(item?.memory_type, kind),
          content: String(content),
          id: item?.id || item?.event_id || item?.profile_id,
          score: item?.score,
          source: item?.session_id ? `viking-memory:${item.session_id}` : "viking-memory",
          scope: item?.memory_type === "profile_v1" ? "user" : item?.group_id ? "workspace" : item?.user_id ? "user" : item?.session_id ? "session" : "user",
          timestamp: item?.time,
          metadata: { status: item?.status || "active", confidence: item?.confidence || "medium", memory_type: item?.memory_type, session_id: item?.session_id, tenant_id: firstString(item?.tenant_id, fallbackTenantId), user_id: firstString(item?.user_id, fallbackUserId), workspace_id: firstString(item?.group_id, item?.memory_type === "profile_v1" ? "__pi_global__" : fallbackGroupId || "local") },
        });
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
