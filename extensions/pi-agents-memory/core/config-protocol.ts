import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { MemoryConfigV1, ConfigValidationResult, MemoryIdentity } from "./contracts.js";
import { localIdentity } from "./contracts.js";
import { loadMemoryPolicy } from "./policy.js";

export function loadCanonicalConfig(env: NodeJS.ProcessEnv = process.env): ConfigValidationResult {
  const fileResult = readVersionedConfig(env.MEMORY_CONFIG_FILE);
  const file = fileResult.config;
  const configErrors = fileResult.errors;
  const fileFlat = flattenFileConfig(file);
  const merged = { ...fileFlat, ...envConfig(env) };
  const backend = normalizeBackend(merged.PI_MEMORY_BACKEND || merged.backend);
  const policy = loadMemoryPolicy();
  const identity = localIdentity({
    tenantId: merged.MEMORY_TENANT_ID || "local",
    userId: merged.VIKING_MEMORY_USER_ID || merged.OPENVIKING_USER || "user_01",
    workspaceId: merged.VIKING_MEMORY_GROUP_ID || merged.OPENVIKING_PEER_ID || "local",
    agentId: merged.VIKING_MEMORY_ASSISTANT_ID || "pi",
    source: merged.MEMORY_IDENTITY_SOURCE as MemoryIdentity["source"] || (file ? "local" : "env"),
  });
  const config: MemoryConfigV1 = {
    schemaVersion: 1,
    revision: file?.revision || `local-${hash({ backend, identity, policy: policy.version })}`,
    source: file ? "file" : "env",
    backend,
    enabled: Boolean(backend),
    credentialRef: backend === "viking-memory" ? "env://MEMORY_API_KEY" : "env://OPENVIKING_API_KEY|file://ovcli.conf",
    identity: { tenantId: identity.tenantId, userId: identity.userId, workspaceId: identity.workspaceId, agentId: identity.agentId, source: identity.source },
    retrieval: {
      purpose: merged.MEMORY_PURPOSE === "chat" ? "chat" : "coding",
      limit: clamp(merged.MEMORY_RECALL_LIMIT, 1, 100, 10),
      maxChars: clamp(merged.MEMORY_RECALL_MAX_CHARS, 500, 50000, 8000),
      minQueryLength: clamp(merged.MEMORY_MIN_QUERY_LENGTH, 1, 64, 2),
      scoreThreshold: numberEnv(merged.MEMORY_SCORE_THRESHOLD, 0.35),
      queryExpansion: merged.MEMORY_QUERY_EXPANSION !== "off",
    },
    capture: {
      enabled: merged.MEMORY_SYNC_TURNS !== "0",
      assistantTurns: merged.MEMORY_CAPTURE_ASSISTANT_TURNS !== "0",
      toolResults: merged.MEMORY_CAPTURE_TOOL_RESULTS === "1",
      maxLength: clamp(merged.MEMORY_CAPTURE_MAX_LENGTH, 200, 100000, 24000),
    },
    lifecycle: {
      expiryEnabled: merged.MEMORY_EXPIRY_ENABLED !== "0",
      consolidationEnabled: merged.MEMORY_CONSOLIDATION_ENABLED === "1",
      conflictPolicy: merged.MEMORY_CONFLICT_POLICY === "auto-merge" ? "auto-merge" : "preserve-and-confirm",
    },
    ui: {
      cards: {
        enabled: merged.MEMORY_UI_CARDS !== "0",
        hint: merged.MEMORY_UI_CARD_HINT !== "0",
        partialPrefix: typeof merged.MEMORY_UI_CARD_PARTIAL_PREFIX === "string" ? merged.MEMORY_UI_CARD_PARTIAL_PREFIX : "In progress",
        maxSummary: clamp(Number(merged.MEMORY_UI_CARD_MAX_SUMMARY) || 0, 0, 400, 0),
      },
    },
    policyVersion: policy.version,
  };
  const errors: string[] = [...configErrors];
  const warnings: string[] = [];
  if (!backend) errors.push("PI_MEMORY_BACKEND must be viking-memory or openviking");
  if (identity.developmentFallback) warnings.push("using local development identity fallback");
  return { valid: errors.length === 0, config, errors, warnings };
}

function flattenFileConfig(file: Record<string, any> | null): Record<string, any> {
  if (!file) return {};
  return {
    PI_MEMORY_BACKEND: file.backend,
    MEMORY_TENANT_ID: file.identity?.tenantId,
    VIKING_MEMORY_USER_ID: file.identity?.userId,
    VIKING_MEMORY_GROUP_ID: file.identity?.workspaceId,
    VIKING_MEMORY_ASSISTANT_ID: file.identity?.agentId,
    MEMORY_IDENTITY_SOURCE: file.identity?.source,
    MEMORY_PURPOSE: file.retrieval?.purpose,
    MEMORY_RECALL_LIMIT: file.retrieval?.limit,
    MEMORY_RECALL_MAX_CHARS: file.retrieval?.maxChars,
    MEMORY_MIN_QUERY_LENGTH: file.retrieval?.minQueryLength,
    MEMORY_SCORE_THRESHOLD: file.retrieval?.scoreThreshold,
    MEMORY_QUERY_EXPANSION: file.retrieval?.queryExpansion === false ? "off" : undefined,
    MEMORY_SYNC_TURNS: file.capture?.enabled === false ? "0" : undefined,
    MEMORY_CAPTURE_ASSISTANT_TURNS: file.capture?.assistantTurns === false ? "0" : undefined,
    MEMORY_CAPTURE_TOOL_RESULTS: file.capture?.toolResults ? "1" : undefined,
    MEMORY_CAPTURE_MAX_LENGTH: file.capture?.maxLength,
    MEMORY_EXPIRY_ENABLED: file.lifecycle?.expiryEnabled === false ? "0" : undefined,
    MEMORY_CONSOLIDATION_ENABLED: file.lifecycle?.consolidationEnabled ? "1" : undefined,
    MEMORY_CONFLICT_POLICY: file.lifecycle?.conflictPolicy,
    MEMORY_UI_CARDS: file.ui?.cards?.enabled === false ? "0" : undefined,
    MEMORY_UI_CARD_HINT: file.ui?.cards?.hint === false ? "0" : undefined,
    MEMORY_UI_CARD_PARTIAL_PREFIX: typeof file.ui?.cards?.partialPrefix === "string" ? String(file.ui.cards.partialPrefix) : undefined,
    MEMORY_UI_CARD_MAX_SUMMARY: typeof file.ui?.cards?.maxSummary === "number" ? String(file.ui.cards.maxSummary) : undefined,
  };
}

function readVersionedConfig(path?: string): { config: Record<string, any> | null; errors: string[] } {
  if (!path) return { config: null, errors: [] };
  if (!existsSync(path)) return { config: null, errors: [`MEMORY_CONFIG_FILE not found: ${path}`] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const errors: string[] = [];
    if (parsed?.schemaVersion !== 1) errors.push("MEMORY_CONFIG_FILE requires schemaVersion=1");
    if (typeof parsed?.revision !== "string" || !parsed.revision.trim()) errors.push("MEMORY_CONFIG_FILE revision must be a non-empty string");
    if (parsed?.source !== undefined && !["defaults", "file", "env", "runtime"].includes(parsed.source)) errors.push("MEMORY_CONFIG_FILE source is invalid");
    if (parsed?.backend !== undefined && !["viking-memory", "openviking"].includes(parsed.backend)) errors.push("MEMORY_CONFIG_FILE backend is invalid");
    if (parsed?.retrieval?.limit !== undefined && !Number.isFinite(Number(parsed.retrieval.limit))) errors.push("MEMORY_CONFIG_FILE retrieval.limit must be numeric");
    if (parsed?.capture?.maxLength !== undefined && !Number.isFinite(Number(parsed.capture.maxLength))) errors.push("MEMORY_CONFIG_FILE capture.maxLength must be numeric");
    return { config: errors.length ? null : parsed, errors };
  } catch (error: any) {
    return { config: null, errors: [`MEMORY_CONFIG_FILE invalid JSON: ${error?.message || "parse error"}`] };
  }
}

function envConfig(env: NodeJS.ProcessEnv): Record<string, any> {
  return { ...env, MEMORY_CONFIG_FILE: undefined };
}

function normalizeBackend(value: string | undefined): "viking-memory" | "openviking" | "" {
  if (value === "viking" || value === "viking-memory") return "viking-memory";
  if (value === "ov" || value === "openviking") return "openviking";
  return "";
}

function clamp(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}
