import type { MemoryMessage } from "./provider.js";

/**
 * Per-process accumulation queue for the rule-miss long tail.
 *
 * Messages whose rule-based candidate extraction found nothing are not lost:
 * they wait here and are batch-fed to the LLM curator once a threshold is
 * reached. Messages are ALSO pushed into the backend session regardless, so a
 * failed/aborted LLM flush loses nothing — the backend commit remains the
 * final safety net.
 */
export class CurationQueue {
  private pending: Array<{ message: MemoryMessage; attempt: number }> = [];
  private readonly thresholdCount: number;
  private readonly thresholdChars: number;
  private readonly maxAttempts: number;

  constructor() {
    this.thresholdCount = clampInt(process.env.PI_MEMORY_LLM_BATCH_COUNT, 1, 100, 4);
    this.thresholdChars = clampInt(process.env.PI_MEMORY_LLM_BATCH_CHARS, 100, 100000, 1200);
    this.maxAttempts = clampInt(process.env.PI_MEMORY_LLM_BATCH_MAX_ATTEMPTS, 1, 20, 3);
  }

  get size(): number { return this.pending.length; }

  estChars(): number {
    return this.pending.reduce((sum, entry) => sum + (entry.message.content?.length || 0), 0);
  }

  enqueue(message: MemoryMessage): void {
    this.pending.push({ message, attempt: 0 });
  }

  shouldFlush(): boolean {
    return this.pending.length > 0 && (this.pending.length >= this.thresholdCount || this.estChars() >= this.thresholdChars);
  }

  /** Take queued messages, marking an attempt. Returns messages eligible for a flush. */
  takeBatch(): MemoryMessage[] {
    const batch = this.pending.map((entry) => entry.message);
    this.pending = [];
    return batch;
  }

  /**
   * Re-queue a batch when the LLM call failed but we still want retries.
   * After maxAttempts the tail is dropped (session ingestion already covered it).
   */
  requeue(batch: MemoryMessage[], attempt = 1): void {
    for (const message of batch) {
      const recordedAttempt = attempt;
      if (recordedAttempt >= this.maxAttempts) continue;
      this.pending.push({ message, attempt: recordedAttempt });
    }
  }

  clear(): void { this.pending = []; }
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}