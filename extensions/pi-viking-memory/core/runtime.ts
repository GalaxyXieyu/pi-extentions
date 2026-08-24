import { FileStatsProvider, type StatsProvider } from "./observability.js";
import { extractCandidates, type CandidateExtractionResult } from "./candidate-extractor.js";
import { decideMerge, isExpired, type LifecycleDecision } from "./lifecycle.js";
import { MemoryPolicyEngine } from "./policy-engine.js";
import type { MemoryIdentity, MemoryRecord, MemoryRequestContext } from "./contracts.js";
import type { MemoryItem } from "./provider.js";
import { sanitizeSensitiveValue } from "./sensitive.mjs";
import { LifecycleStore, lifecycleFingerprint } from "./lifecycle-store.js";
import { GLOBAL_MEMORY_GROUP } from "./workspace-identity.js";

export const memoryStats: StatsProvider = new FileStatsProvider();
export const memoryPolicy = new MemoryPolicyEngine();
const auditRecords: MemoryRecord[] = [];
let lifecycleStore: LifecycleStore | undefined;

function getLifecycleStore(): LifecycleStore {
  if (!lifecycleStore) lifecycleStore = new LifecycleStore();
  return lifecycleStore;
}

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

export async function gateCapture(text: string, identity: MemoryIdentity, context: MemoryRequestContext, lookup: (query: string) => Promise<MemoryItem[]> = async () => []): Promise<RuntimeGateResult> {
  const auth = authorize(context, "capture");
  const extraction = extractCandidates({ text, identity, purpose: context.purpose, sessionId: identity.sessionId, policyVersion: context.policyVersion });
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
    const rejectedRecord = { ...candidateRecord, status: lifecycle.decision === "conflict" ? "conflicted" : lifecycle.decision === "skip" ? "active" : "rejected", metadata: { ...(candidate as any).metadata, lifecycleDecision: lifecycle.decision, lifecycleReason: lifecycle.reason } };
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
    if (context.lifecycle?.expiryEnabled !== false && isExpired(effective)) {
      if (persisted && persisted.status !== "expired") getLifecycleStore().transition(fingerprint, "expired", "validUntil reached");
      return false;
    }
    return !["superseded", "conflicted", "rejected", "archived"].includes(effective.status);
  });
  const selected = memoryPolicy.selectRecall(scoped, context.purpose);
  return { items: selected.items, dropped: items.length - selected.items.length };
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
