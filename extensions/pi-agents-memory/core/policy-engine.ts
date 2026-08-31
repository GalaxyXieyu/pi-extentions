import { loadMemoryPolicy, type MemoryPolicy } from "./policy.js";
import type { MemoryItem } from "./provider.js";

export interface RecallSelection {
  items: MemoryItem[];
  purpose: "chat" | "coding";
  priority: string[];
  quotas: Record<string, number>;
  dropped: number;
}

export class MemoryPolicyEngine {
  readonly policy: MemoryPolicy;

  constructor(policy = loadMemoryPolicy()) {
    this.policy = policy;
  }

  extractionPrompt(purpose: "chat" | "coding"): string {
    return purpose === "coding" ? this.policy.codingExtractionPrompt : this.policy.chatExtractionPrompt;
  }

  selectRecall(items: MemoryItem[], purpose: "chat" | "coding" = "coding"): RecallSelection {
    const config = (this.policy.purposes[purpose] || {}) as { priority?: string[]; quotas?: Record<string, number> };
    const priority = Array.isArray(config.priority) ? config.priority : [];
    const quotas = config.quotas || {};
    const rank = new Map(priority.map((kind, index) => [kind, index]));
    const now = Date.now();
    const eligible = items.filter((item) => {
      const metadata = item.metadata || {};
      const status = String(metadata.status || "active");
      const confidence = String(metadata.confidence || "medium");
      const validUntil = metadata.valid_until || metadata.validUntil;
      if (["superseded", "expired", "rejected", "conflicted"].includes(status)) return false;
      if (confidence === "low" && metadata.default_recall !== true) return false;
      if (validUntil && Date.parse(String(validUntil)) <= now) return false;
      return true;
    });
    const sorted = [...eligible].sort((a, b) => {
      const ar = rank.get(a.kind) ?? priority.length + 1;
      const br = rank.get(b.kind) ?? priority.length + 1;
      if (ar !== br) return ar - br;
      return (b.score ?? 0) - (a.score ?? 0);
    });
    const used: Record<string, number> = {};
    const selected = sorted.filter((item) => {
      const quota = quotas[item.kind];
      if (typeof quota !== "number") return true;
      used[item.kind] = used[item.kind] || 0;
      if (used[item.kind] >= quota) return false;
      used[item.kind]++;
      return true;
    });
    return { items: selected, purpose, priority, quotas, dropped: items.length - selected.length };
  }

  annotate(item: MemoryItem): MemoryItem {
    const metadata = item.metadata || {};
    return {
      ...item,
      scope: item.scope || String(metadata.scope || metadata.visibility || "workspace"),
      metadata: {
        status: metadata.status || "active",
        confidence: metadata.confidence || "medium",
        policy_version: this.policy.version,
        ...metadata,
      },
    };
  }
}
