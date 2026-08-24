export type IdentitySource = "local" | "env" | "session" | "external-auth" | "gateway" | "custom";
export type MemoryScope = "user" | "project" | "workspace" | "department" | "tenant" | "session" | "global";
export type MemoryStatus = "candidate" | "needs-confirmation" | "confirmed" | "active" | "superseded" | "conflicted" | "expired" | "archived" | "rejected";
export type MemoryKind = "profile" | "preference" | "project" | "decision" | "event" | "experience" | "workflow" | "resource" | "session";

export interface MemoryIdentity {
  tenantId: string;
  userId: string;
  departmentIds: string[];
  workspaceId?: string;
  projectId?: string;
  agentId: string;
  sessionId?: string;
  roles: string[];
  source: IdentitySource;
  permissionVersion?: string;
  developmentFallback?: boolean;
}

export interface MemoryIdentityResolver {
  resolve(context: { piSessionId?: string; cwd: string; env: Record<string, string | undefined> }): Promise<MemoryIdentity | null>;
}

export interface MemoryRequestContext {
  identity: MemoryIdentity;
  requestId: string;
  purpose: "chat" | "coding";
  policyVersion: number;
  configRevision: string;
  permissions: string[];
  lifecycle?: { expiryEnabled: boolean; conflictPolicy: "preserve-and-confirm" | "auto-merge" };
  signal?: AbortSignal;
}

export interface MemoryCandidate {
  id?: string;
  kind: MemoryKind | string;
  scope: MemoryScope;
  status: MemoryStatus;
  confidence: "low" | "medium" | "high";
  summary: string;
  content: string;
  owner: { tenantId: string; userId?: string; agentId?: string; workspaceId?: string };
  source: { sessionId?: string; files?: string[]; commands?: string[]; observedAt: string };
  createdAt: string;
  updatedAt: string;
  policyVersion: number;
  security: { verdict: string; findings: string[] };
}

export interface MemoryRecord {
  id?: string;
  kind: MemoryKind | string;
  scope: MemoryScope;
  status: MemoryStatus;
  confidence: "low" | "medium" | "high";
  content: string;
  owner: { tenantId: string; userId?: string; agentId?: string; workspaceId?: string };
  source: { backend?: string; sessionId?: string; files?: string[]; commands?: string[]; requestId?: string; observedAt: string };
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  validUntil?: string | null;
  reviewAt?: string;
  staleAfter?: string;
  supersedes?: string[];
  related?: string[];
  policyVersion: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryConfigV1 {
  schemaVersion: 1;
  revision: string;
  source: "defaults" | "file" | "env" | "runtime";
  backend: "viking-memory" | "openviking";
  enabled: boolean;
  credentialRef: string;
  identity: Partial<Pick<MemoryIdentity, "tenantId" | "userId" | "workspaceId" | "projectId" | "agentId">> & { source: IdentitySource };
  retrieval: { purpose: "chat" | "coding"; limit: number; maxChars: number; minQueryLength: number; scoreThreshold?: number; queryExpansion?: boolean };
  capture: { enabled: boolean; assistantTurns: boolean; toolResults: boolean; maxLength: number };
  lifecycle: { expiryEnabled: boolean; consolidationEnabled: boolean; conflictPolicy: "preserve-and-confirm" | "auto-merge" };
  ui: { cards: { enabled: boolean; hint: boolean; partialPrefix: string; maxSummary: number } };
  policyVersion: number;
}

export interface ConfigValidationResult {
  valid: boolean;
  config: MemoryConfigV1;
  errors: string[];
  warnings: string[];
}

export interface CapabilitySnapshot {
  backend: string;
  provider: Record<string, "supported" | "unsupported" | "unverified">;
  native: Record<string, "supported" | "unsupported" | "unverified">;
  verified: boolean;
  checkedAt: string;
}

export function localIdentity(overrides: Partial<MemoryIdentity> = {}): MemoryIdentity {
  return {
    tenantId: overrides.tenantId || "local",
    userId: overrides.userId || "user_01",
    departmentIds: overrides.departmentIds || ["local"],
    workspaceId: overrides.workspaceId || "local",
    agentId: overrides.agentId || "pi",
    roles: overrides.roles || ["user"],
    source: overrides.source || "local",
    developmentFallback: true,
    ...overrides,
  };
}

export function defaultIdentityResolver(): MemoryIdentityResolver {
  return { resolve: async ({ env }) => localIdentity({ tenantId: env.MEMORY_TENANT_ID || "local", userId: env.VIKING_MEMORY_USER_ID || env.OPENVIKING_USER || "user_01", workspaceId: env.VIKING_MEMORY_GROUP_ID || env.OPENVIKING_PEER_ID || "local", agentId: env.VIKING_MEMORY_ASSISTANT_ID || "pi", source: (env.MEMORY_IDENTITY_SOURCE as IdentitySource) || "env" }) };
}

export function resolverFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryIdentityResolver {
  const resolverModule = env.MEMORY_IDENTITY_RESOLVER;
  if (!resolverModule) return defaultIdentityResolver();
  throw new Error(`Custom identity resolver '${resolverModule}' must be registered by the host runtime; refusing dynamic module loading.`);
}

export function requestContext(identity: MemoryIdentity, options: Partial<Pick<MemoryRequestContext, "purpose" | "policyVersion" | "configRevision" | "permissions" | "lifecycle">> = {}): MemoryRequestContext {
  return {
    identity,
    requestId: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    purpose: options.purpose || "coding",
    policyVersion: options.policyVersion || 1,
    configRevision: options.configRevision || "local-1",
    permissions: options.permissions || ["memory:recall", "memory:capture", "memory:remember", "memory:profile"],
    lifecycle: options.lifecycle || { expiryEnabled: true, conflictPolicy: "preserve-and-confirm" },
  };
}
