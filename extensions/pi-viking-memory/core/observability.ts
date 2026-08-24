import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { localMemoryStatePath } from "./local-paths.js";
import { sanitizeSensitiveValue } from "./sensitive.mjs";

export type MemoryEventType = "extraction" | "recall" | "write" | "error";

export interface MemoryRecord {
  id?: string;
  kind: string;
  scope?: string;
  status?: "candidate" | "confirmed" | "superseded" | "expired";
  confidence?: "low" | "medium" | "high";
  content: string;
  source?: { backend?: string; sessionId?: string; files?: string[]; commands?: string[]; timestamp?: string };
  createdAt?: string;
  updatedAt?: string;
  validUntil?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryEvent {
  type: MemoryEventType;
  backend: string;
  operation: string;
  requestId?: string;
  latencyMs?: number;
  usage?: unknown;
  kind?: string;
  score?: number;
  count?: number;
  error?: string;
  timestamp: string;
}

export interface StatsProvider {
  record(event: Omit<MemoryEvent, "timestamp">): void;
  snapshot(): { events: number; byType: Record<string, number>; byBackend: Record<string, number>; errors: number; averageLatencyMs: number };
  audit(sessionId: string, records: MemoryRecord[]): string;
}

export class FileStatsProvider implements StatsProvider {
  private events: MemoryEvent[] = [];
  private readonly filePath: string;
  constructor(filePath = process.env.PI_MEMORY_STATS_FILE || localMemoryStatePath("events.jsonl")) { this.filePath = filePath; this.load(); }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      for (const line of readFileSync(this.filePath, "utf8").split("\n")) if (line.trim()) this.events.push(JSON.parse(line));
    } catch { /* malformed historical metrics never block runtime; new events still append */ }
  }

  record(event: Omit<MemoryEvent, "timestamp">): void {
    const next = { ...event, timestamp: new Date().toISOString() };
    this.events.push(next);
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(sanitizeSensitiveValue(next)) + "\n");
    } catch { /* observability must not affect memory operations */ }
  }

  snapshot() {
    const byType: Record<string, number> = {};
    const byBackend: Record<string, number> = {};
    let latencyTotal = 0;
    let latencyCount = 0;
    for (const event of this.events) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      byBackend[event.backend] = (byBackend[event.backend] || 0) + 1;
      if (typeof event.latencyMs === "number") { latencyTotal += event.latencyMs; latencyCount++; }
    }
    return { events: this.events.length, byType, byBackend, errors: byType.error || 0, averageLatencyMs: latencyCount ? latencyTotal / latencyCount : 0 };
  }

  audit(sessionId: string, records: MemoryRecord[]): string {
    const receipt = JSON.stringify({ sessionId, generatedAt: new Date().toISOString(), records: sanitizeSensitiveValue(records) }, null, 2);
    const file = process.env.PI_MEMORY_AUDIT_FILE || localMemoryStatePath("audit.jsonl");
    try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, receipt + "\n"); } catch { /* audit must not affect memory */ }
    return receipt;
  }
}
