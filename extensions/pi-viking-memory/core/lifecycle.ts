import type { MemoryRecord, MemoryStatus, MemoryKind } from "./contracts.js";

export type MergeDecision = "skip" | "create" | "merge" | "supersede" | "conflict" | "reject";

export interface LifecycleDecision {
  decision: MergeDecision;
  reason: string;
  candidate: MemoryRecord;
  target?: MemoryRecord;
  policyVersion: number;
}

export function transition(record: MemoryRecord, next: MemoryStatus, reason: string, actor = "system"): MemoryRecord {
  const allowed: Record<MemoryStatus, MemoryStatus[]> = {
    candidate: ["needs-confirmation", "confirmed", "active", "rejected"],
    "needs-confirmation": ["confirmed", "rejected"],
    confirmed: ["active", "superseded", "conflicted", "expired", "archived"],
    active: ["superseded", "conflicted", "expired", "archived"],
    superseded: ["archived"],
    conflicted: ["confirmed", "active", "superseded", "archived"],
    expired: ["archived", "active"],
    archived: [],
    rejected: [],
  };
  if (!allowed[record.status]?.includes(next)) throw new Error(`invalid memory transition ${record.status} -> ${next}`);
  return { ...record, status: next, updatedAt: new Date().toISOString(), metadata: { ...(record.metadata || {}), transitionReason: reason, transitionActor: actor } };
}

export function decideMerge(candidate: MemoryRecord, existing: MemoryRecord | undefined): LifecycleDecision {
  if (!existing) return { decision: "create", reason: "no existing record", candidate, policyVersion: candidate.policyVersion };
  if (candidate.owner.tenantId !== existing.owner.tenantId || candidate.scope !== existing.scope) return { decision: "create", reason: "different ownership or scope", candidate, existing: undefined, policyVersion: candidate.policyVersion };
  if (candidate.kind !== existing.kind) return { decision: "create", reason: "different memory kind", candidate, policyVersion: candidate.policyVersion };
  if (candidate.content.trim() === existing.content.trim()) return { decision: "skip", reason: "exact duplicate", candidate, target: existing, policyVersion: candidate.policyVersion };

  const kind = candidate.kind as MemoryKind;
  if (["profile", "preference", "project", "decision"].includes(kind)) {
    if (candidate.confidence === "high" && ["confirmed", "active"].includes(existing.status)) {
      return { decision: "supersede", reason: "high-confidence replacement of active fact", candidate, target: existing, policyVersion: candidate.policyVersion };
    }
    return { decision: "conflict", reason: "contradictory durable fact requires confirmation", candidate, target: existing, policyVersion: candidate.policyVersion };
  }
  if (["event", "experience"].includes(kind)) return { decision: "merge", reason: "append compatible episodic history", candidate, target: existing, policyVersion: candidate.policyVersion };
  if (kind === "workflow") return { decision: "conflict", reason: "workflow change requires verification", candidate, target: existing, policyVersion: candidate.policyVersion };
  return { decision: "create", reason: "default conservative lifecycle policy", candidate, policyVersion: candidate.policyVersion };
}

export function isExpired(record: Pick<MemoryRecord, "validUntil" | "status">, now = Date.now()): boolean {
  if (record.status === "expired") return true;
  return Boolean(record.validUntil && Date.parse(record.validUntil) <= now);
}
