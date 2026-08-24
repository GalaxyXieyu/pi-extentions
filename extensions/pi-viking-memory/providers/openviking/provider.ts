import { formatRecall } from "../../core/format.js";
import type { CaptureResult, MemoryCapabilities, MemoryItem, MemoryMessage, MemoryProvider, RecallRequest, RecallResult } from "../../core/provider.js";
import type { OVClient, OVSearchResult } from "./client.js";
import type { OVConfig } from "./config.js";
import { replayPending } from "./shared/pending-queue.mjs";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../../core/sensitive.mjs";
import { extractCandidates } from "../../core/candidate-extractor.js";
import { localIdentity } from "../../core/contracts.js";
import { authorize, filterRecall, gateCapture, persistLifecycleRecord, persistLifecycleTransition } from "../../core/runtime.js";
import { lifecycleFingerprint } from "../../core/lifecycle-store.js";
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
    return { backend: this.id, purpose: request.purpose || "coding", items: filtered.items, block: formatRecall({ backend: this.id, items: filtered.items, maxChars: request.maxChars, purpose: request.purpose || "coding" } as any), raw: context };
  }

  async capture(sessionId: string, messages: MemoryMessage[], context?: MemoryRequestContext): Promise<CaptureResult> {
    let count = 0;
    let rejected = 0;
    const decisions: Array<{ decision: string; reason: string; kind?: string }> = [];
    for (const message of messages) {
      const safeMessage = context ? { ...message, metadata: { tenant_id: context.identity.tenantId, user_id: context.identity.userId, agent_id: context.identity.agentId, workspace_id: context.identity.workspaceId, policy_version: context.policyVersion, request_id: context.requestId } } : message;
      if (context) {
        const gate = await gateCapture(message.content, context.identity, context, async (query) => this.search(query, { limit: this.config.recallLimit, context }));
        const decision = gate.lifecycle?.decision || "capture-only";
        decisions.push({ decision, reason: gate.reason, kind: gate.extraction.candidates[0]?.kind });
        if (!gate.allowed && gate.writeMode !== "lifecycle-action") { rejected++; continue; }
        if (gate.writeMode === "session" && decision === "create" && gate.extraction.candidates[0]) {
          const candidateRecord = gate.extraction.candidates[0] as unknown as MemoryRecord;
          const slug = lifecycleFingerprint(candidateRecord);
          const uri = `viking://~/memories/${slug}.md`;
          const written = await this.client.writeContent(uri, candidateRecord.summary, { mode: "create", wait: true });
          if (written && written.uri) {
            persistLifecycleRecord({ ...candidateRecord, status: "active" as const }, written.uri, "remote-create");
            count++;
            continue;
          }
        }
        if (gate.writeMode === "lifecycle-action") {
          const target = gate.lifecycle?.target;
          const uri = target?.id;
          const candidateRecord = gate.extraction.candidates[0] as unknown as MemoryRecord | undefined;
          const content = gate.lifecycle?.decision === "merge" && target ? `${target.content}\n\n${candidateRecord?.summary || message.content}` : (candidateRecord?.summary || sanitizeSensitiveText(message.content));
          const updated = uri?.startsWith("viking://") ? await this.client.writeContent(uri, content, { mode: "replace", wait: true }) : null;
          if (!updated || !target || !candidateRecord) return { accepted: false, count, rejected, candidates: gate.extraction.candidates.length, decisions, backend: this.id, error: "lifecycle-action-deferred:no-writable-memory-uri", raw: gate };
          const next = { ...candidateRecord, content, status: "active" as const, supersedes: target.id ? [target.id] : [] };
          persistLifecycleTransition(target, "superseded", `remote-${gate.lifecycle?.decision}`, target.id);
          persistLifecycleRecord(next, uri, `remote-${gate.lifecycle?.decision}`);
          count++;
          continue;
        }
      }
      const candidate = extractCandidates({ text: safeMessage.content, identity: context?.identity || localIdentity(), purpose: context?.purpose || "coding", sessionId, policyVersion: context?.policyVersion });
      if (candidate.rejected.some((item) => item.reason === "threat" || item.reason === "secret")) { rejected++; continue; }
      const safeContent = sanitizeSensitiveText(safeMessage.content);
      const safeParts = safeMessage.parts?.map((part) => sanitizeSensitiveValue(part));
      const ok = safeParts?.length
        ? await this.client.addMessageParts(sessionId, message.role, safeParts)
        : await this.client.addMessage(sessionId, message.role, safeContent);
      if (!ok) return { accepted: false, count, rejected, backend: this.id, error: "message capture failed" };
      count++;
    }
    return { accepted: true, count, rejected, decisions, backend: this.id };
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
