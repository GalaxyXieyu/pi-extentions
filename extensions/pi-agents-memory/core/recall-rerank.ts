import type { MemoryItem } from "./provider.js";

/**
 * Local zero-cost recall reranking: temporal intent.
 *
 * Vector similarity alone cannot tell "上次怎么修的" (points at older facts)
 * from "现在用的什么" (points at the current fact). A cheap temporal-intent
 * regex nudges item scores before the recall block is formatted. Items keep
 * their updated score so the injected context shows the reranked order.
 */

const TIME_PAST = /(上次|之前|以前|当时|过去|曾经|去年|上个月|last time|previously|before|past)/i;
const TIME_NOW = /(现在|当前|目前|最近|最新|今天|这周|now|current|latest|recent)/i;

export function rerankRecall(items: MemoryItem[], query: string): MemoryItem[] {
  if (!items.length) return items;
  const past = TIME_PAST.test(query);
  const nowBias = TIME_NOW.test(query);
  if (!past && !nowBias) return items;

  const scored = items.map((item) => {
    let boost = 0;
    const rawTs = item.timestamp ?? item.metadata?.time ?? item.metadata?.created_at;
    if (rawTs != null) {
      const parsed = Date.parse(String(rawTs));
      if (Number.isFinite(parsed)) {
        const ageDays = Math.max(0, (Date.now() - parsed) / 86400000);
        const recency = Math.max(0, 1 - ageDays / 365);
        if (nowBias) boost += recency * 0.25;
        if (past) boost += (1 - recency) * 0.15;
      }
    }
    return { item, score: (typeof item.score === "number" ? item.score : 0) + boost };
  }).sort((a, b) => b.score - a.score);

  return scored.map((entry) => ({ ...entry.item, score: entry.score }));
}