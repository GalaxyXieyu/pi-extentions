import type { VikingMemoryConfig } from "./config.js";
import type { VikingMessage } from "./client.js";
import { stripMemoryContext } from "../../core/format.js";
import { sanitizeSensitiveText } from "../../core/sensitive.mjs";

export interface CaptureResult {
  messages: VikingMessage[];
  nextEntryCount: number;
  resetWatermark: boolean;
}

export function extractMessages(branch: unknown[], syncedEntryCount: number, config: VikingMemoryConfig): CaptureResult {
  const entries = Array.isArray(branch) ? branch : [];
  const previous = Math.max(0, Number(syncedEntryCount) || 0);
  const resetWatermark = entries.length < previous;
  const start = resetWatermark ? 0 : Math.min(previous, entries.length);
  const messages: VikingMessage[] = [];

  for (const entry of entries.slice(start)) {
    const payload = entryPayload(entry);
    const role = normalizeRole(payload?.role || payload?.type || payload?.kind);
    if (!payload || !role || (role === "assistant" && !config.captureAssistantTurns)) continue;

    const text = cleanText(extractText(payload));
    if (!text || text.startsWith("/viking-memory") || text.startsWith("[Viking Memory]")) continue;
    messages.push({ role, content: truncate(text, config.captureMaxLength), time: Date.now() });
  }

  return { messages, nextEntryCount: entries.length, resetWatermark };
}

function entryPayload(entry: unknown): Record<string, any> | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, any>;
  if (value.type === "message" && value.message && typeof value.message === "object") return value.message;
  if (value.message && typeof value.message === "object") return value.message;
  return value;
}

function normalizeRole(value: unknown): "user" | "assistant" | "" {
  const role = String(value || "").toLowerCase();
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "";
}

function extractText(payload: Record<string, any>): string {
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  if (Array.isArray(payload.content)) return payload.content.map(blockText).filter(Boolean).join("\n");
  if (Array.isArray(payload.parts)) return payload.parts.map(blockText).filter(Boolean).join("\n");
  return "";
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const value = block as Record<string, any>;
  const type = String(value.type || value.kind || "").toLowerCase();
  if (["tool_call", "tool_use", "tool_result", "tool_output", "toolcall", "toolresult"].includes(type)) {
    const name = value.name || value.tool_name || value.tool || value.function?.name || "tool";
    const body = value.input ?? value.arguments ?? value.output ?? value.result ?? value.content ?? "";
    return `[${type} ${name}] ${compact(body)}`;
  }
  return value.text || value.content || value.output_text || value.input_text || "";
}

function compact(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function cleanText(value: string): string {
  return sanitizeSensitiveText(stripMemoryContext(value))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 20)).trimEnd()}\n[truncated]`;
}
