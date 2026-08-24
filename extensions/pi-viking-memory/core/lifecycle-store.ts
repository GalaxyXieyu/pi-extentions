import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localMemoryStatePath } from "./local-paths.js";
import type { MemoryRecord, MemoryStatus } from "./contracts.js";
import { sanitizeSensitiveValue } from "./sensitive.mjs";

export interface LifecycleLedgerEntry {
  fingerprint: string;
  remoteId?: string;
  record: MemoryRecord;
  history: Array<{ status: MemoryStatus; at: string; reason: string; targetId?: string }>;
}

export class LifecycleStore {
  private entries = new Map<string, LifecycleLedgerEntry>();
  private readonly path: string;
  constructor(path = process.env.PI_MEMORY_LIFECYCLE_FILE || localMemoryStatePath("lifecycle.json")) { this.path = path; this.load(); }

  find(fingerprint: string): LifecycleLedgerEntry | undefined { return this.entries.get(fingerprint); }
  all(): LifecycleLedgerEntry[] { return [...this.entries.values()]; }

  upsert(fingerprint: string, record: MemoryRecord, remoteId?: string, reason = "created"): LifecycleLedgerEntry {
    const now = new Date().toISOString();
    const old = this.entries.get(fingerprint);
    const next: LifecycleLedgerEntry = {
      fingerprint,
      remoteId: remoteId || old?.remoteId,
      record,
      history: [...(old?.history || []), { status: record.status, at: now, reason }],
    };
    this.entries.set(fingerprint, next);
    this.persist();
    return next;
  }

  transition(fingerprint: string, status: MemoryStatus, reason: string, targetId?: string): LifecycleLedgerEntry | undefined {
    const entry = this.entries.get(fingerprint);
    if (!entry) return undefined;
    entry.record = { ...entry.record, status, updatedAt: new Date().toISOString() };
    entry.history.push({ status, at: entry.record.updatedAt, reason, targetId });
    this.persist();
    return entry;
  }

  isActive(fingerprint: string): boolean {
    const status = this.entries.get(fingerprint)?.record.status;
    return !status || ["candidate", "confirmed", "active", "needs-confirmation"].includes(status);
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      for (const item of Array.isArray(parsed?.entries) ? parsed.entries : []) this.entries.set(item.fingerprint, item);
    } catch (error) { throw new Error(`memory lifecycle ledger is unreadable: ${(error as Error).message}`); }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = JSON.stringify(sanitizeSensitiveValue({ version: 1, entries: this.all() }), null, 2);
      writeFileSync(this.path, body, { mode: 0o600 });
    } catch (error) { throw new Error(`memory lifecycle ledger write failed: ${(error as Error).message}`); }
  }
}

export function lifecycleFingerprint(record: Pick<MemoryRecord, "kind" | "scope" | "owner" | "content">): string {
  return `${record.owner.tenantId}|${record.owner.userId || ""}|${record.owner.workspaceId || ""}|${record.kind}|${record.scope}|${record.content.trim().toLowerCase()}`;
}
