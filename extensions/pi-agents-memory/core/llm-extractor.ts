import type { MemoryItem, MemoryMessage } from "./provider.js";

/**
 * Batched LLM memory extraction — stage 2 of the curation pipeline.
 *
 * The rule-based candidate extractor in candidate-extractor.ts stays as the
 * cheap first gate. When PI_MEMORY_LLM_ENABLED=1 and a local OpenAI-compatible
 * endpoint is configured (Ollama serving qwen2.5 / llama3.1 / gemma, or any
 * /v1/chat/completions server), capture calls extractMemories() once per batch
 * instead of per-message rules:
 *
 *   input  = recent message window + new message batch + top-k existing memories
 *   output = { action: add|noop|update, text, kind, scope, confidence, supersedes_id[] }
 *
 * Failures fall back to rule-based classification — extraction must never
 * break capture.
 */

export interface ExtractedMemory {
  action: "add" | "noop" | "update";
  text: string;
  kind?: string;
  scope?: string;
  confidence?: number;
  supersedes_id?: string[];
  reason?: string;
}

export interface LlmExtractionOptions {
  endpoint: string;          // e.g. http://127.0.0.1:11434/v1
  model: string;             // e.g. qwen2.5:7b
  apiKey?: string;           // optional bearer token
  timeoutMs?: number;
  recentWindow?: MemoryMessage[];   // 5-10 recent synced messages (context anchor)
  newBatch: MemoryMessage[];        // messages to extract from
  existingMemories?: MemoryItem[];  // top-k existing memories for add/noop/update decisions
  maxExisting?: number;
  maxCharsPerEntry?: number;
  /** Optional pi-pilot completion hook (inherits pi's provider/auth). */
  complete?: LlmCompleteFn;
}

/**
 * A completion hook supplied by the pi host: messages in (system+user), final
 * text out. When present, extraction inherits the pi session's provider,
 * model, and credentials — zero standalone LLM configuration.
 */
export type LlmCompleteFn = (messages: Array<{ role: "system" | "user"; content: string }>) => Promise<string>;

export interface LlmExtractionResult {
  ok: boolean;
  memories: ExtractedMemory[];
  error?: string;
  fallbackToRules: boolean;
}

/**
 * Master switch for ANY model use (nightly sweep, and the opt-in inline path).
 * Default ON; set PI_MEMORY_LLM_ENABLED=0 to keep the plugin purely rule-based
 * everywhere, including the nightly curation job.
 */
export function llmExtractionEnabled(): boolean {
  const raw = String(process.env.PI_MEMORY_LLM_ENABLED ?? "1").toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/**
 * Whether the LLM may run *inside a live session* (rule-miss batch funnel and
 * conflict arbitration).
 *
 * Default OFF: conversation capture is keyword/rule-only and never blocks
 * `turn_end` waiting on a model. Model work happens in the nightly sweep
 * (`scripts/nightly-sweep.mjs`), which reads the transcript files instead.
 * Set PI_MEMORY_LLM_INLINE=1 to bring the in-session funnel back.
 */
export function inlineLlmEnabled(): boolean {
  if (!llmExtractionEnabled()) return false;
  const raw = String(process.env.PI_MEMORY_LLM_INLINE ?? "0").toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function llmEndpoint(): string {
  return String(process.env.PI_MEMORY_LLM_URL || "").replace(/\/+$/, "");
}

export function llmModel(): string {
  return String(process.env.PI_MEMORY_LLM_MODEL || process.env.PI_MEMORY_LLM_MODEL_NAME || "qwen2.5:7b").trim();
}

export const EXTRACTION_SYSTEM_PROMPT = [
  "You are a STRICT memory curator for a coding agent. Your default answer is noop: most conversation content is NOT worth remembering.",
  "",
  "Extract a memory ONLY when it satisfies ALL three tests:",
  "  1. durable     - still true and useful across future sessions (weeks, not this turn)",
  "  2. stable      - decided / verified / confirmed, not an in-progress discussion or a one-off workaround",
  "  3. reusable    - changes future agent behavior (preferences, conventions, architecture choices, verified fixes)",
  "",
  "NEVER extract (skip all of these):",
  "  - one-off task decisions or temporary workarounds (e.g. \"this time disable the update via env var\", \"for now use X\")",
  "  - project implementation details you could re-read from the repo (file layout, package names, command syntax, config values)",
  "  - conversation events: who asked what, what happened this turn (\"user asked about…\", \"I did X\", \"user_01 asks…\")",
  "  - in-progress discussion, speculation, alternatives being weighed, questions",
  "  - greetings, thanks, small talk, and any [tool] action/output content",
  "  - anything the user merely mentions without confirming",
  "",
  "Examples:",
  "  KEEP  \"以后都先用 pnpm 装依赖\"                 -> preference (explicit, durable)",
  "  KEEP  \"这个仓库用 pnpm workspace,入口在 packages/*\" -> project (verified, stable)",
  "  KEEP  \"之前端口冲突是因为 XX,改成 YY 后验证通过\"   -> experience (root cause + verified fix)",
  "  SKIP  \"这次先不自动装,用环境变量关掉提示\"         -> one-off workaround, NOT a memory",
  "  SKIP  \"user asked whether updates install automatically\" -> conversation event, NOT a memory",
  "  SKIP  \"我在看 package.json 里的脚本\"            -> task state, NOT a memory",
  "",
  "When in doubt, output noop. Only confirm a decision when the user explicitly and finally decided it.",
  "",
  "Compare each candidate fact with the provided existing memories and decide:",
  "  - add: durable new fact, or a compatible continuation",
  "  - noop: equivalent fact already exists, or the fact is not worth remembering",
  "  - update: the new fact clearly replaces an existing one; list its ids in supersedes_id",
  "Prefer update only when the replacement is explicit. Otherwise keep both (add).",
  "Set confidence >= 0.85 only for explicit, verified facts; 0.5-0.84 for normal; below 0.5 output noop instead.",
  "Output STRICT JSON only:",
  '{"memories":[{"action":"add|noop|update","text":"...","kind":"preference|project|decision|experience|event|workflow|profile","scope":"user|workspace","confidence":0.0,"supersedes_id":["id"],"reason":"..."}]}',
].join("\n");

export function buildExtractionPrompt(opts: LlmExtractionOptions): string {
  const parts: string[] = [];

  if (opts.recentWindow?.length) {
    parts.push("[RECENT CONTEXT — already synced, do not re-extract]\n" + renderMessages(opts.recentWindow, opts.maxCharsPerEntry ?? 1200));
  }

  parts.push("[NEW MESSAGES — extract from these]\n" + renderMessages(opts.newBatch, opts.maxCharsPerEntry ?? 2400));

  const existing = (opts.existingMemories || []).slice(0, opts.maxExisting ?? 8);
  if (existing.length) {
    parts.push("[EXISTING MEMORIES — compare against]\n" + existing.map((m) => `- id="${m.id || ""}" kind="${m.kind}" scope="${m.scope || "workspace"}" :: ${clip(String(m.content || ""), opts.maxCharsPerEntry ?? 600)}`).join("\n"));
  } else {
    parts.push("[EXISTING MEMORIES]\n(none)");
  }

  return parts.join("\n\n");
}

function renderMessages(messages: MemoryMessage[], maxChars: number): string {
  return messages.map((m) => {
    const role = m.role === "assistant" ? "assistant" : "user";
    const body = clip(String(m.content || ""), maxChars);
    const toolHint = Array.isArray(m.parts) && m.parts.length
      ? ` [agent used tools: ${m.parts.map((p: any) => p?.tool_name || "").filter(Boolean).join(", ")}]`
      : "";
    return `${role}: ${body}${toolHint}`;
  }).join("\n\n");
}

function clip(value: string, max: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 16).trimEnd()} [truncated]`;
}

export async function extractMemories(opts: LlmExtractionOptions): Promise<LlmExtractionResult> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const promptMessages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: buildExtractionPrompt(opts) },
  ];

  // Host-piloted path: inherit pi's provider/auth. No endpoint needed.
  if (opts.complete) {
    try {
      const text = await opts.complete(promptMessages);
      return parseExtractionResponse(text);
    } catch (err: any) {
      return { ok: false, memories: [], error: String(err?.message || err), fallbackToRules: true };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${opts.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: promptMessages,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, memories: [], error: `LLM extraction HTTP ${res.status}`, fallbackToRules: true };
    }

    const body: any = await res.json().catch(() => null);
    const text = String(body?.choices?.[0]?.message?.content || "");
    return parseExtractionResponse(text);
  } catch (err: any) {
    const timedOut = err?.name === "AbortError";
    return { ok: false, memories: [], error: timedOut ? "timeout" : String(err?.message || err), fallbackToRules: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Shared JSON parse + validation for both completion channels. */
function parseExtractionResponse(text: string): LlmExtractionResult {
  if (!text) return { ok: false, memories: [], error: "empty LLM extraction response", fallbackToRules: true };

  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, memories: [], error: "non-JSON LLM extraction response", fallbackToRules: true };

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false, memories: [], error: "invalid JSON LLM extraction response", fallbackToRules: true };
  }

  const raw = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const memories: ExtractedMemory[] = raw
    .filter((m: any) => m && typeof m.text === "string" && String(m.text).trim())
    .map((m: any) => ({
      action: ["add", "noop", "update"].includes(m.action) ? m.action : "add",
      text: String(m.text).trim(),
      kind: String(m.kind || "").trim() || undefined,
      scope: String(m.scope || "").trim() || undefined,
      confidence: typeof m.confidence === "number" ? Math.max(0, Math.min(1, m.confidence)) : undefined,
      supersedes_id: Array.isArray(m.supersedes_id) ? m.supersedes_id.map(String) : undefined,
      reason: String(m.reason || "").trim() || undefined,
    }));
  return { ok: true, memories, fallbackToRules: false };
}