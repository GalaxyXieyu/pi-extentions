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
}

export interface LlmExtractionResult {
  ok: boolean;
  memories: ExtractedMemory[];
  error?: string;
  fallbackToRules: boolean;
}

export function llmExtractionEnabled(): boolean {
  return process.env.PI_MEMORY_LLM_ENABLED === "1" && Boolean(process.env.PI_MEMORY_LLM_URL);
}

export function llmEndpoint(): string {
  return String(process.env.PI_MEMORY_LLM_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
}

export function llmModel(): string {
  return String(process.env.PI_MEMORY_LLM_MODEL || process.env.PI_MEMORY_LLM_MODEL_NAME || "qwen2.5:7b").trim();
}

export const EXTRACTION_SYSTEM_PROMPT = [
  "You are a memory curator utility for a coding agent.",
  "Extract only durable, cross-session facts from the conversation below: user preferences, project facts, confirmed decisions, verified debugging experiences, reusable workflows.",
  "Do not extract temporary task state, greetings, tool output content, or anything in [tool] action lines beyond what the agent chose to do.",
  "Compare each fact with the provided existing memories and decide:",
  '  - add: new fact, or a compatible continuation (events/experiences)',
  "  - noop: an equivalent fact already exists",
  "  - update: the new fact clearly replaces an existing one; list its ids in supersedes_id",
  "Prefer update only when the replacement is explicit. Otherwise keep both (add).",
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
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: buildExtractionPrompt(opts) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, memories: [], error: `LLM extraction HTTP ${res.status}`, fallbackToRules: true };
    }

    const body: any = await res.json().catch(() => null);
    const text = String(body?.choices?.[0]?.message?.content || "");
    if (!text) return { ok: false, memories: [], error: "empty LLM extraction response", fallbackToRules: true };

    const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < start) return { ok: false, memories: [], error: "non-JSON LLM extraction response", fallbackToRules: true };

    const parsed = JSON.parse(cleaned.slice(start, end + 1));
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
  } catch (err: any) {
    const timedOut = err?.name === "AbortError";
    return { ok: false, memories: [], error: timedOut ? "timeout" : String(err?.message || err), fallbackToRules: true };
  } finally {
    clearTimeout(timer);
  }
}