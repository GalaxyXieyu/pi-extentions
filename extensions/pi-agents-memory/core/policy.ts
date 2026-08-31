import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface MemoryPolicy {
  version: number;
  candidateSchema: Record<string, unknown>;
  common: Record<string, unknown>;
  purposes: Record<string, unknown>;
  kinds: Record<string, unknown>;
  codingExtractionPrompt: string;
  chatExtractionPrompt: string;
}

export function loadMemoryPolicy(moduleUrl = import.meta.url): MemoryPolicy {
  const path = join(dirname(fileURLToPath(moduleUrl)), "memory-policy.json");
  return JSON.parse(readFileSync(path, "utf8")) as MemoryPolicy;
}

export function extractionPrompt(purpose: "chat" | "coding"): string {
  const policy = loadMemoryPolicy();
  return purpose === "coding" ? policy.codingExtractionPrompt : policy.chatExtractionPrompt;
}
