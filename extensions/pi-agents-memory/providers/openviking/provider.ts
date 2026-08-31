import { formatRecall } from "../../core/format.js";
import type { CaptureResult, MemoryCapabilities, MemoryItem, MemoryMessage, MemoryProvider, RecallRequest, RecallResult } from "../../core/provider.js";
import type { OVClient, OVSearchResult } from "./client.js";
import type { OVConfig } from "./config.js";
import { replayPending } from "./shared/pending-queue.mjs";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";
import { extractCandidates } from "../../core/candidate-extractor.js";
import { localIdentity } from "../../core/contracts.js";
import { lifecycleFingerprint } from "../../core/lifecycle-store.js";
import { authorize, curateWithLlm, filterRecall, gateCapture, persistLifecycleRecord, persistLifecycleTransition, memoryHistoryById } from "../../core/runtime.js";
import { llmExtractionEnabled, inlineLlmEnabled } from "../../core/llm-extractor.js";
import type { LlmCompleteFn } from "../../core/llm-extractor.js";
import { makeConflictArbiter, type ConflictArbiter } from "../../core/conflict-arbiter.js";
import { rerankRecall } from "../../core/recall-rerank.js";
import { CurationQueue } from "../../core/curation-queue.js";
import type { MemoryRequestContext, MemoryRecord } from "../../core/contracts.js";

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

  private readonly curationQueue = new CurationQueue();
  private pilotComplete: LlmCompleteFn | null = null;
  private arbiter: ConflictArbiter = makeConflictArbiter(null);

  /** Inherit pi's provider/auth for the LLM funnel (zero standalone config). */
  setPilotComplete(complete: LlmCompleteFn | null): void {
    this.pilotComplete = complete;
    this.arbiter = makeConflictArbiter(complete);
  }

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
      queryExpansion: this.config.recallQueryExpansion,
      scoreThreshold: this.config.scoreThreshold,
    });
    const items = contextItems(context, request.context?.identity);
    const filtered = request.context ? filterRecall(items, request.context) : { items, dropped: 0 };
    const reranked = rerankRecall(filtered.items, request.query);
    const historyById = request.context?.identity ? memoryHistoryById(request.context.identity) : new Map<string, string[]>();
    return { backend: this.id, purpose: request.purpose || "coding", items: reranked, block: formatRecall({ backend: this.id, items: reranked, maxChars: request.maxChars, purpose: request.purpose || "coding" } as any, { historyById }), raw: context };
  }

  async capture(sessionId: string, messages: MemoryMessage[], context?: MemoryRequestContext): Promise<CaptureResult> {
    let count = 0;
    let rejected = 0;
    const decisions: Array<{ decision: string; reason: string; kind?: string }> = [];
    const conflicts: Array<{ fingerprint?: string; kind: string; candidate: string; targetId?: string; targetContent?: string }> = [];

    for (const message of messages) {
      const safeMessage = context ? { ...message, metadata: { tenant_id: context.identity.tenantId, user_id: context.identity.userId, agent_id: context.identity.agentId, workspace_id: context.identity.workspaceId, policy_version: context.policyVersion, request_id: context.requestId } } : message;
      const ruleCandidates = extractCandidates({ text: safeMessage.content, identity: context?.identity || localIdentity(), purpose: context?.purpose || "coding", sourceType: message.role === "assistant" ? "agent" : "user", sessionId, policyVersion: context?.policyVersion });
      if (ruleCandidates.rejected.some((item) => item.reason === "threat" || item.reason === "secret")) { rejected++; continue; }

      const ruleHit = ruleCandidates.candidates.length > 0;
      let gateHandled = false;

      if (context && ruleHit) {
        const gate = await gateCapture(message.content, context.identity, context, async (query) => this.search(query, { limit: this.config.recallLimit, context }), message.role === "assistant" ? "agent" : "user", this.arbiter);
        const decision = gate.lifecycle?.decision || "capture-only";
        decisions.push({ decision, reason: gate.reason, kind: gate.extraction.candidates[0]?.kind });
        if (gate.lifecycle?.decision === "conflict") {
          const conflictRecord = gate.extraction.candidates[0] as unknown as MemoryRecord | undefined;
          conflicts.push({
            fingerprint: conflictRecord ? lifecycleFingerprint(conflictRecord) : undefined,
            kind: String(conflictRecord?.kind || gate.extraction.candidates[0]?.kind || ""),
            candidate: String(conflictRecord?.summary || conflictRecord?.content || message.content || "").slice(0, 300),
            targetId: gate.lifecycle?.target?.id,
            targetContent: String(gate.lifecycle?.target?.content || "").slice(0, 300),
          });
        }
        if (!gate.allowed && gate.writeMode !== "lifecycle-action") { rejected++; gateHandled = true; }
        if (!gateHandled && gate.writeMode === "session" && decision === "create" && gate.extraction.candidates[0]) {
          const candidateRecord = gate.extraction.candidates[0] as unknown as MemoryRecord;
          const slug = lifecycleFingerprint(candidateRecord);
          const uri = `viking://~/memories/${slug}.md`;
          const written = await this.client.writeContent(uri, candidateRecord.summary, { mode: "create", wait: true });
          if (written && written.uri) {
            persistLifecycleRecord({ ...candidateRecord, status: "active" as const }, written.uri, "remote-create");
            count++;
            gateHandled = true;
          }
        }
        if (!gateHandled && gate.writeMode === "lifecycle-action") {
          const target = gate.lifecycle?.target;
          const uri = target?.id;
          const candidateRecord = gate.extraction.candidates[0] as unknown as MemoryRecord | undefined;
          const content = gate.lifecycle?.decision === "merge" && target ? `${target.content}\n\n${candidateRecord?.summary || message.content}` : (candidateRecord?.summary || sanitizeSensitiveText(message.content));
          const updated = uri?.startsWith("viking://") ? await this.client.writeContent(uri, content, { mode: "replace", wait: true }) : null;
          if (!updated || !target || !candidateRecord) return { accepted: false, count, rejected, candidates: gate.extraction.candidates.length, decisions, conflicts, backend: this.id, error: "lifecycle-action-deferred:no-writable-memory-uri", raw: gate };
          const next = { ...candidateRecord, content, status: "active" as const, supersedes: target.id ? [target.id] : [] };
          persistLifecycleTransition(target, "superseded", `remote-${gate.lifecycle?.decision}`, target.id);
          persistLifecycleRecord(next, uri, `remote-${gate.lifecycle?.decision}`);
          count++;
          gateHandled = true;
        }
      } else if (context && !ruleHit) {
        // Rule-miss long tail. By default nothing is curated in-session: the
        // message still goes into the OV session below and the nightly sweep
        // re-reads the transcript later. Only PI_MEMORY_LLM_INLINE=1 re-queues
        // for an in-session batch flush.
        if (inlineLlmEnabled()) this.curationQueue.enqueue({ role: message.role, content: safeMessage.content });
      }

      const safeContent = sanitizeSensitiveText(safeMessage.content);
      const safeParts = safeMessage.parts?.map((part) => sanitizeSensitiveValue(part));
      const ok = safeParts?.length
        ? await this.client.addMessageParts(sessionId, message.role, safeParts)
        : await this.client.addMessage(sessionId, message.role, safeContent);
      if (!ok) return { accepted: false, count, rejected, decisions, conflicts, backend: this.id, error: "message capture failed" };
      count++;
    }

    // Batch LLM curation flush for the rule-miss tail (opt-in only).
    if (context && inlineLlmEnabled() && this.curationQueue.shouldFlush()) {
      const flushed = await this.flushCuration(sessionId, context);
      decisions.push(...flushed.decisions);
      rejected += flushed.rejected;
      count += flushed.count;
    }

    return { accepted: true, count, rejected, decisions, conflicts, backend: this.id };
  }

  /** Flush queued rule-miss messages through the batch LLM curator (opt-in). */
  async flushCuration(sessionId: string, context: MemoryRequestContext): Promise<{ handled: boolean; count: number; rejected: number; decisions: Array<{ decision: string; reason: string; kind?: string }>; error?: string }> {
    if (!inlineLlmEnabled() || this.curationQueue.size === 0) return { handled: false, count: 0, rejected: 0, decisions: [] };
    const batch = this.curationQueue.takeBatch();
    if (!batch.length) return { handled: false, count: 0, rejected: 0, decisions: [] };
    const result = await this.curateBatch(batch, sessionId, context);
    if (!result.handled) this.curationQueue.requeue(batch);
    return result;
  }

  /**
   * Run one message batch through the LLM curator and apply its decisions to
   * the backend. Called from the inline queue flush (opt-in) and from the
   * nightly sweep, which feeds whole transcripts instead of a live tail.
   */
  async curateBatch(batch: MemoryMessage[], _sessionId: string, context: MemoryRequestContext): Promise<{ handled: boolean; count: number; rejected: number; decisions: Array<{ decision: string; reason: string; kind?: string }>; error?: string }> {
    const decisions: Array<{ decision: string; reason: string; kind?: string }> = [];
    if (!llmExtractionEnabled() || batch.length === 0) return { handled: false, count: 0, rejected: 0, decisions, error: llmExtractionEnabled() ? "empty batch" : "PI_MEMORY_LLM_ENABLED=0" };

    const curated = await curateWithLlm(batch, context.identity, context, async (query) => this.search(query, { limit: this.config.recallLimit, context }), this.pilotComplete ?? undefined);
    if (!curated.handled) return { handled: false, count: 0, rejected: 0, decisions, error: curated.error };

    let count = 0;
    let rejected = 0;
    for (const d of curated.decisions) {
      const record = d.candidate;
      if (d.action === "update" && d.target) {
        const uri = d.target.id;
        const merged = `${d.target.content}\n\nUPDATED: ${record.content}`;
        const updated = uri?.startsWith("viking://") ? await this.client.writeContent(uri, merged, { mode: "replace", wait: true }) : null;
        if (!updated || !uri) { rejected++; decisions.push({ decision: "update", reason: "remote-update-failed", kind: record.kind }); continue; }
        persistLifecycleTransition(d.target, "superseded", "llm-update", uri);
        persistLifecycleRecord({ ...record, status: "active" as const }, uri, "llm-update");
        count++;
        decisions.push({ decision: "update", reason: d.reason || "llm", kind: record.kind });
      } else if (d.action === "add") {
        const uri = `viking://~/memories/${lifecycleFingerprint(record)}.md`;
        const written = await this.client.writeContent(uri, record.content, { mode: "create", wait: true });
        if (!written || !written.uri) { rejected++; decisions.push({ decision: "add", reason: "remote-create-failed", kind: record.kind }); continue; }
        persistLifecycleRecord({ ...record, status: "active" as const }, written.uri, "llm-create");
        count++;
        decisions.push({ decision: "add", reason: d.reason || "llm", kind: record.kind });
      }
    }
    return { handled: true, count, rejected, decisions };
  }

  async commit(sessionId: string): Promise<CaptureResult> {
    const result = await this.client.commitSessionResponse(sessionId);
    return result.result
      ? { accepted: true, count: 0, backend: this.id, raw: result.result }
      : { accepted: false, count: 0, backend: this.id, error: result.error?.message || "commit failed" };
  }

  async search(query: string, options?: { limit?: number; context?: MemoryRequestContext }): Promise<MemoryItem[]> {
    const context = await this.client.searchContext(query, { limit: options?.limit ?? this.config.recallLimit, queryExpansion: this.config.recallQueryExpansion, scoreThreshold: this.config.scoreThreshold });
    const items = contextItems(context, options?.context?.identity);
    return options?.context ? filterRecall(items, options.context).items : items;
  }

  async remember(content: string, options?: { sessionId?: string; context?: MemoryRequestContext }): Promise<CaptureResult> {
    if (!options?.sessionId) return { accepted: false, count: 0, backend: this.id, error: "sessionId is required" };
    if (options.context && !authorize(options.context, "remember").allowed) return { accepted: false, count: 0, backend: this.id, error: "permission-denied:remember" };
    const candidate = extractCandidates({ text: content, identity: options.context?.identity || localIdentity(), purpose: options.context?.purpose || "coding", sessionId: options.sessionId, policyVersion: options.context?.policyVersion });
    if (candidate.rejected.length) return { accepted: false, count: 0, backend: this.id, error: `memory candidate rejected: ${candidate.rejected[0].reason}`, raw: candidate };
    const safeContent = sanitizeSensitiveText(content);
    const ok = await this.client.addMessage(options.sessionId, "user", `[Remember] ${safeContent}`);
    return { accepted: ok, count: ok ? 1 : 0, backend: this.id, raw: { path: `/api/v1/sessions/${options.sessionId}/messages`, body: { role: "user", content: `[Remember] ${safeContent}` } }, error: ok ? undefined : "message capture failed" };
  }

  async updateProfile(profile: string): Promise<CaptureResult> {
    this.unsupported("direct profile write; use session extraction or OpenViking memory policy");
  }

  capabilitiesSnapshot() {
    return {
      backend: this.id,
      provider: Object.fromEntries(Object.entries(this.capabilities).map(([key, value]) => [key, value ? "supported" : "unsupported"])),
      native: Object.fromEntries(Object.entries(this.nativeCapabilities).map(([key, value]) => [key, value ? "supported" : "unsupported"])),
      verified: this.client.connected,
      checkedAt: new Date().toISOString(),
    };
  }

  unsupported(operation: string): never {
    throw new Error(`Memory backend '${this.id}' does not support '${operation}' through the unified adapter.`);
  }
}

function contextItems(context: any, identity?: { tenantId: string; userId: string; workspaceId?: string }): MemoryItem[] {
  if (!context || typeof context !== "object") return [];
  const all = [
    ...(Array.isArray(context.memories) ? context.memories : []),
    ...(Array.isArray(context.resources) ? context.resources : []),
    ...(Array.isArray(context.skills) ? context.skills : []),
  ];
  if (all.length > 0) return all.map((item) => toMemoryItem(item, identity));
  if (typeof context.rendered === "string" && context.rendered.trim()) {
    return [{ kind: "event", content: context.rendered.trim(), source: "openviking-context", scope: "workspace", metadata: { assembled: true, status: "active", confidence: "medium", tenant_id: identity?.tenantId || "local", user_id: identity?.userId || "pi", workspace_id: identity?.workspaceId || "local" } }];
  }
  return [];
}

function toMemoryItem(item: OVSearchResult, identity?: { tenantId: string; userId: string; workspaceId?: string }): MemoryItem {
  return {
    kind: item.context_type === "skill" ? "workflow" : item.context_type === "resource" ? "resource" : "event",
    content: item.abstract || item.overview || item.uri,
    id: item.uri,
    score: item.score,
    source: item.uri,
    scope: item.category || "workspace",
    metadata: { level: item.level, match_reason: item.match_reason, status: "active", confidence: item.score >= 0.8 ? "high" : item.score >= 0.5 ? "medium" : "low", tenant_id: identity?.tenantId || "local", user_id: identity?.userId || "pi", workspace_id: identity?.workspaceId || item.category || "local" },
  };
}
