import type { MemoryIdentity, MemoryRecord } from "./contracts.js";
import type { LifecycleLedgerEntry } from "./lifecycle-store.js";
import { getLifecycleStore } from "./lifecycle-store.js";

/**
 * Offline "active consolidation" pass (optimization 4).
 *
 * Conflict detection so far is passive: a contradiction is only found when a
 * NEW message bumps into an existing memory. Consolidation flips that — it
 * scans the local lifecycle ledger for similar active/confirmed memories of
 * the same kind+scope and proactively promotes suspicious pairs to
 * pending_review, so unresolved duplicates/contradictions surface even without
 * new input.
 *
 * Similarity is a local character bigram (Dice) coefficient — zero cost, no
 * LLM. The LLM path is intentionally not used here: the existing pending
 * review tools already resolve whatever this pass flags.
 */

export interface ConsolidationFinding {
  a: LifecycleLedgerEntry;
  b: LifecycleLedgerEntry;
  similarity: number;
  suggestion: "skip" | "merge" | "conflict";
  promoted: boolean;
}

const REVIEWABLE = new Set(["active", "confirmed", "candidate", "needs-confirmation"]);

export function consolidateLocal(identity: MemoryIdentity, minSimilarity = 0.6): ConsolidationFinding[] {
  const store = getLifecycleStore();
  const entries = store.all().filter((entry) => {
    const record = entry.record;
    const ownerOk = record.owner?.tenantId === identity.tenantId
      && (!record.owner?.userId || record.owner.userId === identity.userId)
      && (!record.owner?.workspaceId || record.owner.workspaceId === identity.workspaceId);
    return ownerOk && REVIEWABLE.has(record.status);
  });

  const groups = new Map<string, LifecycleLedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.record.kind}|${entry.record.scope}`;
    const list = groups.get(key) || [];
    list.push(entry);
    groups.set(key, list);
  }

  const findings: ConsolidationFinding[] = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const similarity = diceSimilarity(a.record.content, b.record.content);
        if (similarity < minSimilarity) continue;
        const kind = String(a.record.kind);
        const suggestion: ConsolidationFinding["suggestion"] =
          a.record.content.trim() === b.record.content.trim() ? "skip"
          : ["event", "experience"].includes(kind) ? "merge"
          : "conflict";
        const promoted = promotePair(a, b, suggestion);
        findings.push({ a, b, similarity, suggestion, promoted });
      }
    }
  }
  return findings;
}

function promotePair(a: LifecycleLedgerEntry, b: LifecycleLedgerEntry, suggestion: ConsolidationFinding["suggestion"]): boolean {
  if (suggestion === "skip") return false;
  const store = getLifecycleStore();
  let promoted = false;
  for (const entry of [a, b]) {
    if (entry.record.status !== "pending_review" && REVIEWABLE.has(entry.record.status)) {
      const contradicts = entry.record.contradicts || [];
      const otherRemote = entry === a ? b.remoteId : a.remoteId;
      const otherId = entry === a ? b.record.id : a.record.id;
      const target = otherRemote || otherId;
      if (target && !contradicts.includes(String(target))) contradicts.push(String(target));
      store.upsert(
        entry.fingerprint,
        { ...entry.record, status: "pending_review", contradicts, updatedAt: new Date().toISOString() },
        entry.remoteId,
        "consolidation-flagged",
      );
      promoted = true;
    }
  }
  return promoted;
}

/** Character bigram Dice similarity in [0,1]. */
export function diceSimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let overlap = 0;
  const seen = new Set<string>();
  for (const gram of bigramsA) {
    if (!seen.has(gram) && bigramsB.includes(gram)) { overlap++; seen.add(gram); }
    seen.add(gram);
  }
  return (2 * overlap) / Math.max(1, bigramsA.length + bigramsB.length);
}

function normalize(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function bigrams(text: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i++) grams.push(text.slice(i, i + 2));
  return grams;
}

/** Report without promotion — used by listing tools. */
export function consolidationReport(identity: MemoryIdentity, minSimilarity = 0.6): ConsolidationFinding[] {
  return consolidateLocal(identity, minSimilarity);
}