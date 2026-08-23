import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VikingMemoryConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  collectionName: string;
  projectName: string;
  userId: string;
  assistantId: string;
  groupId: string;
  recallTokenBudget: number;
  recallLimit: number;
  minQueryLength: number;
  captureMaxLength: number;
  captureAssistantTurns: boolean;
  syncTurns: boolean;
  logLevel: "silent" | "error" | "info";
}

const DEFAULT_CONFIG: VikingMemoryConfig = {
  enabled: true,
  endpoint: "https://api-knowledgebase.mlp.cn-beijing.volces.com",
  apiKey: "",
  collectionName: "piAgent",
  projectName: "default",
  userId: "user_01",
  assistantId: "pi",
  groupId: "",
  recallTokenBudget: 4000,
  recallLimit: 10,
  minQueryLength: 2,
  captureMaxLength: 24000,
  captureAssistantTurns: true,
  syncTurns: true,
  logLevel: "error",
};

export function loadConfigFromModuleUrl(moduleUrl: string): VikingMemoryConfig {
  return loadConfig(dirname(fileURLToPath(moduleUrl)));
}

export function loadConfig(extensionDir: string): VikingMemoryConfig {
  let file: Record<string, unknown> = {};
  const configPath = join(extensionDir, "config.json");
  try {
    if (existsSync(configPath)) file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    file = {};
  }

  const config: VikingMemoryConfig = {
    ...DEFAULT_CONFIG,
    ...file,
    endpoint: stringEnv("VIKING_MEMORY_URL", DEFAULT_CONFIG.endpoint, file.endpoint),
    // Secrets are environment-only. Ignore config.json.apiKey even if present.
    apiKey: String(process.env.MEMORY_API_KEY || "").trim(),
    collectionName: stringEnv("VIKING_MEMORY_COLLECTION", DEFAULT_CONFIG.collectionName, file.collectionName),
    projectName: stringEnv("VIKING_MEMORY_PROJECT", DEFAULT_CONFIG.projectName, file.projectName),
    userId: stringEnv("VIKING_MEMORY_USER_ID", DEFAULT_CONFIG.userId, file.userId),
    assistantId: stringEnv("VIKING_MEMORY_ASSISTANT_ID", DEFAULT_CONFIG.assistantId, file.assistantId),
    groupId: stringEnv("VIKING_MEMORY_GROUP_ID", DEFAULT_CONFIG.groupId, file.groupId),
    recallTokenBudget: clampInt(file.recallTokenBudget, 500, 50000, DEFAULT_CONFIG.recallTokenBudget),
    recallLimit: clampInt(file.recallLimit, 1, 100, DEFAULT_CONFIG.recallLimit),
    minQueryLength: clampInt(file.minQueryLength, 1, 64, DEFAULT_CONFIG.minQueryLength),
    captureMaxLength: clampInt(file.captureMaxLength, 200, 100000, DEFAULT_CONFIG.captureMaxLength),
    captureAssistantTurns: file.captureAssistantTurns !== false,
    syncTurns: file.syncTurns !== false,
    logLevel: file.logLevel === "silent" || file.logLevel === "info" ? file.logLevel : DEFAULT_CONFIG.logLevel,
  };

  return config;
}

function stringEnv(name: string, fallback: string, fileValue: unknown): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  const configured = typeof fileValue === "string" ? fileValue.trim() : "";
  return configured || fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}
