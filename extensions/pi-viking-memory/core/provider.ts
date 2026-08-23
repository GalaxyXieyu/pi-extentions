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
}

export interface RecallRequest {
  query: string;
  sessionId?: string;
  purpose?: "chat" | "coding";
  maxChars?: number;
  limit?: number;
}

export interface RecallResult {
  backend: MemoryBackendId;
  items: MemoryItem[];
  block: string | null;
  raw?: unknown;
}

export interface CaptureResult {
  accepted: boolean;
  count: number;
  backend: MemoryBackendId;
  raw?: unknown;
  error?: string;
  delivered?: boolean;
}

export interface MemoryProvider {
  readonly id: MemoryBackendId;
  readonly capabilities: MemoryCapabilities;
  health(): Promise<boolean>;
  ensureSession?(sessionId: string): Promise<boolean>;
  replayPending?(): Promise<{ replayed: number; failed: number; skipped: number; deferred: number }>;
  probeCapabilities?(): Promise<{ backend: MemoryBackendId; capabilities: MemoryCapabilities; verified: boolean; unsupported: string[] }>;
  recall(request: RecallRequest): Promise<RecallResult>;
  capture(sessionId: string, messages: MemoryMessage[]): Promise<CaptureResult>;
  commit?(sessionId: string): Promise<CaptureResult>;
  search(query: string, options?: { limit?: number; kind?: MemoryKind | string }): Promise<MemoryItem[]>;
  remember(content: string, options?: { kind?: MemoryKind | string; sessionId?: string }): Promise<CaptureResult>;
  updateProfile(profile: string): Promise<CaptureResult>;
  capabilitiesSnapshot(): { backend: MemoryBackendId; capabilities: MemoryCapabilities };
  unsupported(operation: string): never;
}

export function capabilitiesSnapshot(provider: Pick<MemoryProvider, "id" | "capabilities">): { backend: MemoryBackendId; capabilities: MemoryCapabilities } {
  return { backend: provider.id, capabilities: { ...provider.capabilities } };
}

export function emptyRecall(backend: MemoryBackendId): RecallResult {
  return { backend, items: [], block: null };
}
