import type { MemoryItem } from "./provider.js";
import type { LlmCompleteFn } from "./llm-extractor.js";

/**
 * LLM conflict arbiter — second-stage refinement for rule-triggered conflicts.
 *
 * The rule path (semantic lookup + decideMerge) is a cheap recall gate. When it
 * flags a conflict, the arbiter asks an LLM to classify the actual relation
 * between the new fact and the Top-K existing memories. Arbitration results
 * overrule rules only in the safe directions:
 *
 *   duplicate   -> skip         (rules would have double-written)
 *   supplement  -> merge        (rules would have confirmed a conflict)
 *   supersede*  -> supersede    (* only with confidence >= threshold)
 *   conflict    -> conflict     (pending_review + human confirmation)
 *   unrelated   -> create       (rules mis-flagged; write as a new memory)
 *
 * When no LLM is available (null complete, or any failure) the caller falls
 * back to plain rules.
 */

export interface ConflictArbitration {
  relation: "duplicate" | "supplement" | "supersede" | "conflict" | "unrelated";
  confidence: number;
  reason?: string;
  targetId?: string;
}

export type ConflictArbiter = (
  candidateText: string,
  existingItems: MemoryItem[],
) => Promise<ConflictArbitration | null>;

const ARBITER_SYSTEM_PROMPT = [
  "You are a memory conflict arbiter for a coding agent's long-term memory.",
  "Given ONE new fact and a list of existing memories, classify the relation.",
  "",
  "Relations:",
  '  "duplicate"   - the new fact states the same thing an existing memory already holds',
  '  "supplement"  - the new fact adds detail or context without contradicting anything',
  '  "supersede"   - the new fact clearly replaces an existing one (state migration, tool switch, version bump)',
  '  "conflict"    - the two facts genuinely contradict each other and neither visibly wins',
  '  "unrelated"   - no substantive relation (rule recall was noise)',
  "",
  "Output STRICT JSON only:",
  '{"relation":"duplicate|supplement|supersede|conflict|unrelated","confidence":0.0,"reason":"one short sentence","target_id":"id of the most relevant existing memory, or omit"',
].join("\n");

export function buildArbiterPrompt(candidateText: string, existingItems: MemoryItem[]): string {
  const existing = existingItems.slice(0, 3).map((item, index) => {
    const id = String(item.id || `mem-${index}`);
    const content = String(item.content || "").replace(/\s+/g, " ").trim().slice(0, 400);
    return `- id="${id}" kind="${item.kind}" :: ${content}`;
  });
  return [
    `NEW FACT:\n${candidateText.replace(/\s+/g, " ").trim().slice(0, 800)}`,
    "",
    "EXISTING MEMORIES:",
    existing.length ? existing.join("\n") : "(none)",
  ].join("\n");
}

/** Parse the LLM's JSON response. Any failure returns null (fall back to rules). */
export function parseArbitration(raw: string): ConflictArbitration | null {
  try {
    const text = String(raw || "").trim();
    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const relation = String(parsed?.relation || "").toLowerCase().trim();
    if (!["duplicate", "supplement", "supersede", "conflict", "unrelated"].includes(relation)) return null;
    const confidence = typeof parsed?.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;
    const targetId = parsed?.target_id ? String(parsed.target_id) : parsed?.targetId ? String(parsed.targetId) : undefined;
    const reason = parsed?.reason ? String(parsed.reason).trim() : undefined;
    return { relation: relation as ConflictArbitration["relation"], confidence, reason, targetId };
  } catch {
    return null;
  }
}

/** Build an arbiter from a pilot completion hook (never throws). */
export function makeConflictArbiter(complete: LlmCompleteFn | null | undefined): ConflictArbiter {
  return async (candidateText, existingItems) => {
    if (!complete) return null;
    try {
      const text = await complete([
        { role: "system", content: ARBITER_SYSTEM_PROMPT },
        { role: "user", content: buildArbiterPrompt(candidateText, existingItems) },
      ]);
      return parseArbitration(text);
    } catch {
      return null;
    }
  };
}