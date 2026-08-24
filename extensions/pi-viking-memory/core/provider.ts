import type { MemoryRequestContext, MemoryRecord } from "./contracts.js";

export type MemoryBackendId = "viking-memory" | "openviking";
export type MemoryKind = "profile" | "preference" | "project" | "decision" | "event" | "experience" | "workflow" | "resource" | "session";

export interface MemoryCapabilities {
  automaticRecall: boolean;
  sessionCapture: boolean;
  semanticSearch: boolean;
  explicitRemember: boolean;
  profileWrite: boolean;
  resourceIngest: boolean;
  uriRead: boolean;
  contextTakeover: boolean;
  archiveExpand: boolean;
}

export interface MemoryMessage {
  role: "user" | "assistant";
  content: string;
  time?: number;
  parts?: unknown[];
  metadata?: { tenant_id?: string; user_id?: string; agent_id?: string; workspace_id?: string; policy_version?: number; request_id?: string };
}

export interface MemoryItem {
  id?: string;
  kind: MemoryKind | string;
  content: string;
  score?: number;
  source?: string;
  scope?: string;
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
  record?: Partial<MemoryRecord>;
}

export interface RecallRequest {
  query: string;
  context?: MemoryRequestContext;
  sessionId?: string;
  purpose?: "chat" | "coding";
  maxChars?: number;
  limit?: number;
}

export interface RecallResult {
  backend: MemoryBackendId;
  purpose?: "chat" | "coding";
  items: MemoryItem[];
  block: string | null;
  raw?: unknown;
}

export interface CaptureResult {
  accepted: boolean;
  rejected?: number;
  candidates?: number;
  count: number;
  backend: MemoryBackendId;
  raw?: unknown;
  error?: string;
  delivered?: boolean;
  decisions?: Array<{ decision: string; reason: string; kind?: string }>;
}

export interface MemoryProvider {
  readonly id: MemoryBackendId;
  readonly capabilities: MemoryCapabilities;
  health(): Promise<boolean>;
  ensureSession?(sessionId: string): Promise<boolean>;
  replayPending?(): Promise<{ replayed: number; failed: number; skipped: number; deferred: number }>;
  probeCapabilities?(): Promise<{ backend: MemoryBackendId; capabilities: MemoryCapabilities; verified: boolean; unsupported: string[] }>;
  recall(request: RecallRequest): Promise<RecallResult>;
  capture(sessionId: string, messages: MemoryMessage[], context?: MemoryRequestContext): Promise<CaptureResult>;
  commit?(sessionId: string): Promise<CaptureResult>;
  search(query: string, options?: { limit?: number; kind?: MemoryKind | string; context?: MemoryRequestContext }): Promise<MemoryItem[]>;
  remember(content: string, options?: { kind?: MemoryKind | string; sessionId?: string; context?: MemoryRequestContext }): Promise<CaptureResult>;
  updateProfile(profile: string, context?: MemoryRequestContext): Promise<CaptureResult>;
  capabilitiesSnapshot(): { backend: MemoryBackendId; capabilities: MemoryCapabilities };
  unsupported(operation: string): never;
}

export function capabilitiesSnapshot(provider: Pick<MemoryProvider, "id" | "capabilities">): { backend: MemoryBackendId; capabilities: MemoryCapabilities } {
  return { backend: provider.id, capabilities: { ...provider.capabilities } };
}

export function emptyRecall(backend: MemoryBackendId): RecallResult {
  return { backend, items: [], block: null };
}
