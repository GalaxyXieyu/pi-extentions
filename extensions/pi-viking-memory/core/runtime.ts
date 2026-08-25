import { FileStatsProvider, type StatsProvider } from "./observability.js";
import { extractCandidates, type CandidateExtractionResult } from "./candidate-extractor.js";
import { decideMerge, isExpired, type LifecycleDecision } from "./lifecycle.js";
import { MemoryPolicyEngine } from "./policy-engine.js";
import type { MemoryIdentity, MemoryRecord, MemoryRequestContext } from "./contracts.js";
import type { MemoryItem, MemoryMessage } from "./provider.js";
import { sanitizeSensitiveValue } from "./sensitive.mjs";
import { getLifecycleStore, lifecycleFingerprint, type LifecycleLedgerEntry } from "./lifecycle-store.js";
import { GLOBAL_MEMORY_GROUP } from "./workspace-identity.js";
import { extractMemories, llmEndpoint, llmExtractionEnabled, llmModel, type LlmCompleteFn } from "./llm-extractor.js";
import { scanMemoryContent } from "./content-scanner.js";
import { classify } from "./candidate-extractor.js";
import type { MemoryKind } from "./contracts.js";
import { consolidateLocal, type ConsolidationFinding } from "./consolidation.js";

export const memoryStats: StatsProvider = new FileStatsProvider();
export const memoryPolicy = new MemoryPolicyEngine();
const auditRecords: MemoryRecord[] = [];

export interface RuntimeGateResult {
  allowed: boolean;
  writeMode?: "session" | "lifecycle-action" | "audit-only";
  reason: string;
  context: MemoryRequestContext;
  extraction: CandidateExtractionResult;
  lifecycle?: LifecycleDecision;
}

export function authorize(context: MemoryRequestContext, operation: "recall" | "capture" | "remember" | "profile"): { allowed: boolean; reason: string } {
  const identity = context.identity;
  if (!identity.tenantId || !identity.userId || !identity.agentId) return { allowed: false, reason: "identity-incomplete" };
  if (!context.permissions.includes(`memory:${operation}`) && !context.permissions.includes("memory:admin")) return { allowed: false, reason: `permission-denied:${operation}` };
  if (identity.source === "external-auth" && identity.permissionVersion === undefined) return { allowed: false, reason: "permission-version-missing" };
  return { allowed: true, reason: "allowed" };
}

function recordFromItem(item: MemoryItem, context: MemoryRequestContext): MemoryRecord {
  const metadata = item.metadata || {};
  const now = new Date().toISOString();
  return {
    id: item.id,
    kind: item.kind,
    scope: (metadata.scope || item.scope || "workspace") as any,
    status: (metadata.status || "active") as any,
    confidence: (metadata.confidence || "medium") as any,
    content: item.content,
    owner: {
      tenantId: String(metadata.tenant_id || context.identity.tenantId),
      userId: String(metadata.user_id || context.identity.userId),
      agentId: String(metadata.agent_id || context.identity.agentId),
      workspaceId: String(metadata.workspace_id || context.identity.workspaceId || "local"),
    },
    source: { backend: context.identity.source, sessionId: String(metadata.session_id || context.identity.sessionId || ""), observedAt: now },
    createdAt: now,
    updatedAt: now,
    validUntil: (metadata.valid_until || metadata.validUntil || null) as string | null,
    policyVersion: context.policyVersion,
    metadata,
  };
}

export async function gateCapture(text: string, identity: MemoryIdentity, context: MemoryRequestContext, lookup: (query: string) => Promise<MemoryItem[]> = async () => [], sourceType: "user" | "agent" | "system" = "user"): Promise<RuntimeGateResult> {
  const auth = authorize(context, "capture");
  const extraction = extractCandidates({ text, identity, purpose: context.purpose, sessionId: identity.sessionId, policyVersion: context.policyVersion, sourceType });
  if (!auth.allowed) {
    auditRecords.push({ kind: "session", scope: "session", status: "rejected", confidence: "high", content: "capture denied", owner: { tenantId: identity.tenantId, userId: identity.userId, agentId: identity.agentId }, source: { sessionId: identity.sessionId, requestId: context.requestId, observedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policyVersion: context.policyVersion, metadata: { decision: "reject", reason: auth.reason } } as MemoryRecord);
    memoryStats.record({ type: "error", backend: "runtime", operation: "capture-gate", requestId: context.requestId, error: auth.reason });
    return { allowed: false, reason: auth.reason, context, extraction };
  }
  if (extraction.rejected.length) {
    memoryStats.record({ type: "error", backend: "runtime", operation: "capture-gate", requestId: context.requestId, error: extraction.rejected[0].reason, count: extraction.rejected.length });
    return { allowed: false, reason: extraction.rejected[0].reason, context, extraction };
  }
  const candidate = extraction.candidates[0];
  if (!candidate) return { allowed: true, writeMode: "session", reason: "no-durable-candidate", context, extraction };
  const existing = await lookup(candidate.summary);
  const target = existing.find((item) => item.kind === candidate.kind && (item.scope || "workspace") === candidate.scope);
  const candidateRecord = candidate as unknown as MemoryRecord;
  const fingerprint = lifecycleFingerprint(candidateRecord);
  const persisted = getLifecycleStore().find(fingerprint);
  let lifecycle = decideMerge(candidateRecord, target ? recordFromItem(target, context) : persisted?.record);
  if (context.lifecycle?.conflictPolicy === "preserve-and-confirm" && ["merge", "supersede"].includes(lifecycle.decision)) {
    lifecycle = { ...lifecycle, decision: "conflict", reason: "configured preserve-and-confirm" };
  }
  if (!["create"].includes(lifecycle.decision)) {
    if (["merge", "supersede"].includes(lifecycle.decision)) {
      memoryStats.record({ type: "write", backend: "runtime", operation: "lifecycle-action-pending", requestId: context.requestId, kind: candidate.kind, error: `${lifecycle.decision}:${lifecycle.reason}` });
      return { allowed: true, writeMode: "lifecycle-action", reason: `lifecycle-${lifecycle.decision}`, context, extraction, lifecycle };
    }
    const decisionStatus = lifecycle.decision === "conflict" ? "pending_review" : lifecycle.decision === "skip" ? "active" : "rejected";
    const contradicts = lifecycle.decision === "conflict"
      ? (candidateRecord.contradicts ?? (lifecycle.target?.id ? [lifecycle.target.id] : []))
      : undefined;
    const rejectedRecord = {
      ...candidateRecord,
      status: decisionStatus,
      contradicts,
      metadata: { ...candidateRecord.metadata, lifecycleDecision: lifecycle.decision, lifecycleReason: lifecycle.reason, reviewAt: lifecycle.decision === "conflict" ? new Date().toISOString() : undefined },
    } as MemoryRecord;
    if (lifecycle.target && lifecycle.decision === "conflict") {
      const targetFp = lifecycleFingerprint(lifecycle.target);
      if (getLifecycleStore().find(targetFp)) {
        persistLifecycleTransition(lifecycle.target, "pending_review", "contradicting candidate arrived");
      }
      auditRecords.push({ ...lifecycle.target, status: "pending_review", metadata: { ...(lifecycle.target.metadata || {}), contradictedBy: rejectedRecord.content } });
    }
    getLifecycleStore().upsert(fingerprint, rejectedRecord, undefined, lifecycle.reason);
    auditRecords.push(rejectedRecord);
    memoryStats.record({ type: "error", backend: "runtime", operation: "lifecycle-decision", requestId: context.requestId, kind: candidate.kind, error: `${lifecycle.decision}:${lifecycle.reason}` });
    memoryStats.audit(identity.sessionId || context.requestId, [rejectedRecord]);
    return { allowed: false, writeMode: "audit-only", reason: `lifecycle-${lifecycle.decision}`, context, extraction, lifecycle };
  }
  const record = { ...candidateRecord, status: lifecycle.decision === "create" ? "active" : "superseded", supersedes: lifecycle.target?.id ? [lifecycle.target.id] : [] };
  getLifecycleStore().upsert(fingerprint, record, undefined, lifecycle.reason);
  if (lifecycle.target?.id && lifecycle.decision === "supersede") getLifecycleStore().transition(lifecycleFingerprint(lifecycle.target), "superseded", lifecycle.reason, record.id);
  auditRecords.push(record);
  memoryStats.record({ type: "write", backend: context.identity.source, operation: "lifecycle-decision", requestId: context.requestId, kind: candidate.kind, error: lifecycle.decision === "create" ? undefined : lifecycle.reason });
  memoryStats.audit(identity.sessionId || context.requestId, [record]);
  return { allowed: true, writeMode: "session", reason: lifecycle.decision, context, extraction, lifecycle };
}

export function filterRecall(items: MemoryItem[], context: MemoryRequestContext): { items: MemoryItem[]; dropped: number } {
  const auth = authorize(context, "recall");
  if (!auth.allowed) return { items: [], dropped: items.length };
  const scoped = items.filter((item) => {
    const metadata = item.metadata || {};
    const owner = String(metadata.user_id || metadata.owner_user_id || "");
    const tenant = String(metadata.tenant_id || "");
    const workspace = String(metadata.workspace_id || metadata.group_id || "");
    const isGlobalProfile = item.kind === "profile" && workspace === GLOBAL_MEMORY_GROUP;
    const isCurrentWorkspace = workspace === context.identity.workspaceId;
    // Fail closed: only this project's memories plus explicit global profiles
    // may reach the model context. Other projects are never a fallback.
    if (!owner || !tenant || owner !== context.identity.userId || tenant !== context.identity.tenantId || (!isCurrentWorkspace && !isGlobalProfile)) return false;
    const record = recordFromItem(item, context);
    const fingerprint = lifecycleFingerprint(record);
    const persisted = getLifecycleStore().find(fingerprint)?.record;
    const effective = persisted || record;
    if (persisted) getLifecycleStore().touch(fingerprint);
    if (context.lifecycle?.expiryEnabled !== false && isExpired(effective)) {
      if (persisted && persisted.status !== "expired") getLifecycleStore().transition(fingerprint, "expired", "validUntil reached");
      return false;
    }
    return !["superseded", "conflicted", "rejected", "archived"].includes(effective.status);
  });
  const selected = memoryPolicy.selectRecall(scoped, context.purpose);
  // pending_review memories stay recallable so the conflict resurfaces, but are
  // clearly marked; low confidence pending_review items are dropped to keep the
  // injected context free of unresolved noise.
  const annotated = selected.items.map((item) => {
    if (item.metadata?.status === "pending_review") return { ...item, metadata: { ...item.metadata, pending_review: true } };
    return item;
  });
  return { items: annotated, dropped: items.length - selected.items.length };
}

export function persistLifecycleRecord(record: MemoryRecord, remoteId: string | undefined, reason: string): void {
  getLifecycleStore().upsert(lifecycleFingerprint(record), record, remoteId, reason);
}

export function backfillLifecycleRemoteId(candidate: MemoryRecord, remoteId: string | undefined, reason = "remote-create"): boolean {
  const store = getLifecycleStore();
  const fingerprint = lifecycleFingerprint(candidate);
  const existing = store.find(fingerprint);
  if (!existing) return false;
  if (existing.remoteId && existing.remoteId !== remoteId) return false;
  store.upsert(fingerprint, existing.record, remoteId || existing.remoteId, existing.reason || reason);
  return true;
}

export function persistLifecycleTransition(record: MemoryRecord, status: MemoryRecord["status"], reason: string, targetId?: string): void {
  getLifecycleStore().transition(lifecycleFingerprint(record), status, reason, targetId);
}

export function recentAuditRecords(sessionId?: string): MemoryRecord[] {
  return auditRecords.filter((record) => !sessionId || record.source?.sessionId === sessionId);
}

export function auditReceipt(sessionId: string, identity: MemoryIdentity, records: MemoryRecord[] = []): string {
  const combined = [...auditRecords, ...records].filter((record) => !record.source?.sessionId || record.source.sessionId === sessionId);
  return memoryStats.audit(sessionId, combined.map((record) => ({ ...record, owner: { ...record.owner, tenantId: identity.tenantId, userId: identity.userId } })));

}

export function measure<T>(operation: string, backend: string, fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  const started = Date.now();
  return fn().then((result) => {
    memoryStats.record({ type: operation === "recall" ? "recall" : operation === "capture" ? "extraction" : "write", backend, operation, latencyMs: Date.now() - started, ...extra });
    return result;
  }).catch((error) => {
    memoryStats.record({ type: "error", backend, operation, latencyMs: Date.now() - started, error: String(error?.message || error) });
    throw error;
  });
}

// ================================================================
// LLM-assisted batch curation (stage 2)
// ================================================================

const LLM_KINDS: MemoryKind[] = ["profile", "preference", "project", "decision", "event", "experience", "workflow", "resource"];

export interface LlmCaptureDecision {
  action: "add" | "noop" | "update";
  candidate: MemoryRecord;
  target?: MemoryRecord;
  reason?: string;
}

function clipQuery(messages: MemoryMessage[]): string {
  return messages
    .map((m) => String(m.content || ""))
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

/**
 * Batch extraction through a local/remote OpenAI-compatible LLM endpoint.
 * Returns `handled=false` when disabled/unavailable so callers fall back to
 * rule-based per-message capture.
 */
export async function curateWithLlm(
  messages: MemoryMessage[],
  identity: MemoryIdentity,
  context: MemoryRequestContext,
  lookup: (query: string) => Promise<MemoryItem[]>,
  complete?: LlmCompleteFn,
): Promise<{ handled: boolean; decisions: LlmCaptureDecision[] }> {
  if (!llmExtractionEnabled()) return { handled: false, decisions: [] };
  // Needs at least one completion source: pilot hook or an endpoint.
  if (!complete && !process.env.PI_MEMORY_LLM_URL) return { handled: false, decisions: [] };
  const query = clipQuery(messages);
  if (!query) return { handled: false, decisions: [] };

  const existing = await lookup(query);
  const result = await extractMemories({
    endpoint: llmEndpoint(),
    model: llmModel(),
    newBatch: messages,
    existingMemories: existing,
    complete,
  });
  if (!result.ok || result.fallbackToRules) {
    memoryStats.record({ type: "error", backend: "llm", operation: "curation", requestId: context.requestId, error: result.error || "llm-unavailable" });
    return { handled: false, decisions: [] };
  }

  const decisions: LlmCaptureDecision[] = [];
  let rejectedSecrets = 0;
  for (const entry of result.memories) {
    const scan = scanMemoryContent(entry.text);
    if (scan.action === "reject" || scan.action === "threat") { rejectedSecrets++; continue; }

    const kind = LLM_KINDS.includes(entry.kind as MemoryKind) ? entry.kind as MemoryKind : classify(entry.text, context.purpose);
    if (!kind) continue;

    const now = new Date().toISOString();
    const confidence: "low" | "medium" | "high" = typeof entry.confidence === "number"
      ? (entry.confidence >= 0.85 ? "high" : entry.confidence >= 0.5 ? "medium" : "low")
      : "medium";
    const scope = entry.scope === "user" ? "user" : (kind === "profile" || kind === "preference" ? "user" : "workspace");

    const candidateRecord: MemoryRecord = {
      kind,
      scope,
      status: kind === "decision" ? "needs-confirmation" : "candidate",
      confidence,
      content: scan.text.trim(),
      owner: { tenantId: identity.tenantId, userId: identity.userId, agentId: identity.agentId, workspaceId: identity.workspaceId },
      source: { backend: "llm-curation", sessionId: identity.sessionId, requestId: context.requestId, observedAt: now },
      createdAt: now,
      updatedAt: now,
      policyVersion: context.policyVersion,
      metadata: { llm_reason: entry.reason, llm_action: entry.action },
    };

    let target: MemoryRecord | undefined;
    let action: LlmCaptureDecision["action"] = entry.action;
    if (action === "update") {
      const supersededId = entry.supersedes_id?.[0];
      const matched = supersededId ? existing.find((item) => item.id === supersededId || item.source === supersededId) : undefined;
      if (matched) {
        target = recordFromItem(matched, context);
      } else {
        action = "add";
      }
    } else if (action === "noop") {
      continue;
    }

    decisions.push({
      action,
      candidate: { ...candidateRecord, supersedes: target?.id ? [target.id] : undefined },
      target,
      reason: entry.reason,
    });
  }

  memoryStats.record({ type: "extraction", backend: "llm", operation: "curation", requestId: context.requestId, count: decisions.length, error: rejectedSecrets ? `rejected-secrets:${rejectedSecrets}` : undefined });
  return { handled: true, decisions };
}

// ================================================================
// Pending review workflow (stage 3)
// ================================================================

export function listPendingReviews(identity: MemoryIdentity): LifecycleLedgerEntry[] {
  return getLifecycleStore().all().filter((entry) => {
    const record = entry.record;
    const ownerOk = record.owner?.tenantId === identity.tenantId
      && (!record.owner?.userId || record.owner.userId === identity.userId)
      && (!record.owner?.workspaceId || record.owner.workspaceId === identity.workspaceId);
    return ownerOk && (record.status === "pending_review");
  });
}

export type ReviewAction = "accept-new" | "keep-old" | "merge";

export function resolveReview(entry: { fingerprint: string }, action: ReviewAction, reason = "user-review"): { ok: boolean; error?: string; record?: MemoryRecord } {
  const store = getLifecycleStore();
  const current = entry ? store.find(entry.fingerprint) : undefined;
  if (!current) return { ok: false, error: "pending review not found" };

  const record = current.record;
  if (record.status !== "pending_review") return { ok: false, error: `memory is not pending review (status=${record.status})` };

  if (action === "accept-new") {
    const next = { ...record, status: "active" as const, updatedAt: new Date().toISOString() };
    store.upsert(current.fingerprint, next, current.remoteId, `accepted:${reason}`);
    auditRecords.push(next);
    memoryStats.record({ type: "write", backend: "runtime", operation: "review-resolved", kind: next.kind, error: action });
    return { ok: true, record: next };
  } else if (action === "keep-old") {
    const next = { ...record, status: "rejected" as const, updatedAt: new Date().toISOString() };
    store.upsert(current.fingerprint, next, current.remoteId, `rejected:${reason}`);
    const contradicts = record.contradicts || [];
    for (const targetId of contradicts) {
      const targetEntries = store.all().filter((e) => e.remoteId === targetId || e.record.id === targetId);
      for (const t of targetEntries) {
        if (t.record.status === "pending_review") store.upsert(t.fingerprint, { ...t.record, status: "active" as const, updatedAt: new Date().toISOString() }, t.remoteId, `kept-old:${reason}`);
      }
    }
    auditRecords.push(next);
    memoryStats.record({ type: "write", backend: "runtime", operation: "review-resolved", kind: next.kind, error: action });
    return { ok: true, record: next };
  } else if (action === "merge") {
    const merged = record.supersedes?.[0] || record.contradicts?.[0];
    const next = { ...record, status: "active" as const, updatedAt: new Date().toISOString(), supersedes: merged ? [merged] : record.supersedes };
    store.upsert(current.fingerprint, next, current.remoteId, `merged:${reason}`);
    auditRecords.push(next);
    memoryStats.record({ type: "write", backend: "runtime", operation: "review-resolved", kind: next.kind, error: action });
    return { ok: true, record: next };
  } else {
    return { ok: false, error: `unknown review action ${action}` };
  }
}

// ================================================================
// Human-in-the-loop review (pi TUI)
// ================================================================

export type ReviewMode = "notify" | "confirm" | "silent";

export function reviewMode(): ReviewMode {
  const raw = String(process.env.MEMORY_REVIEW_MODE || "notify").toLowerCase();
  if (raw === "confirm") return "confirm";
  if (raw === "silent") return "silent";
  return "notify";
}

export interface ReviewConflict {
  fingerprint: string;
  kind: string;
  candidate: string;
  targetId?: string;
  targetContent?: string;
}

/**
 * Prompt the user through pi's TUI when a conflict needs confirmation.
 *
 * - confirm mode: blocking `ctx.ui.select` (only when a UI exists).
 * - notify mode (default): non-blocking notification; conflict stays pending
 *   for the `viking_review` tool or a later session.
 * - silent mode: no UI interaction; pending review only.
 */
export async function handleReviewPrompts(
  ui: any,
  conflicts: ReviewConflict[],
): Promise<{ resolved: number; deferred: number }> {
  const mode = reviewMode();
  if (mode === "silent" || !conflicts.length) return { resolved: 0, deferred: conflicts.length };

  if (mode === "confirm" && typeof ui?.select === "function") {
    let resolved = 0;
    for (const conflict of conflicts) {
      const label = conflict.candidate.slice(0, 120);
      const old = conflict.targetContent ? conflict.targetContent.slice(0, 120) : "(unknown)";
      let choice: string | null = null;
      try {
        choice = await ui.select(`VM conflict: new fact "${label}" vs existing "${old}"`, [
          "accept-new (new fact wins)",
          "keep-old (existing memory wins)",
          "merge (combine both)",
          "defer (keep pending)",
        ]);
      } catch {
        choice = "defer";
      }
      if (choice && choice.startsWith("accept-new")) { resolveReview({ fingerprint: conflict.fingerprint }, "accept-new", "tui-confirm"); resolved++; }
      else if (choice && choice.startsWith("keep-old")) { resolveReview({ fingerprint: conflict.fingerprint }, "keep-old", "tui-confirm"); resolved++; }
      else if (choice && choice.startsWith("merge")) { resolveReview({ fingerprint: conflict.fingerprint }, "merge", "tui-confirm"); resolved++; }
    }
    return { resolved, deferred: conflicts.length - resolved };
  }

  // notify mode
  if (typeof ui?.notify === "function") {
    ui.notify(`Viking: ${conflicts.length} conflicting memor(ies) pending review. Use the review tool or ask me to resolve.`);
  }
  return { resolved: 0, deferred: conflicts.length };
}

// ================================================================
// Timeline history lookup (superseded versions of a remote id)
// ================================================================

/**
 * Map remoteId → prior content versions (superseded records) so recalled active
 * memories can show their timeline: "现在用 pnpm（v1: 用 npm）".
 */
export function memoryHistoryById(identity: MemoryIdentity): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of getLifecycleStore().all()) {
    const record = entry.record;
    if (record.owner?.tenantId !== identity.tenantId) continue;
    if (record.status !== "superseded") continue;
    const key = entry.remoteId || record.id;
    if (!key) continue;
    if (String(record.content).toLowerCase() === String((map.get(key) || [])[0] || "").toLowerCase()) continue;
    map.set(key, [...(map.get(key) || []), String(record.content)]);
  }
  return map;
}

// ================================================================
// Consolidation trigger
// ================================================================

/**
 * Run the offline consolidation pass and surface findings through the UI hook.
 * Called from session_start (fire-and-forget) or the consolidate command.
 */
export async function runConsolidationPass(identity: MemoryIdentity, ui?: any): Promise<{ findings: ConsolidationFinding[]; promoted: number }> {
  const findings = consolidateLocal(identity);
  const promoted = findings.filter((f) => f.promoted).length;
  memoryStats.record({ type: "write", backend: "runtime", operation: "consolidation", count: findings.length, error: promoted ? `promoted:${promoted}` : undefined });
  if (ui?.notify && promoted > 0) ui.notify(`Viking: consolidation flagged ${promoted} similar/contradicting memor(ies) for review.`);
  return { findings, promoted };
}
