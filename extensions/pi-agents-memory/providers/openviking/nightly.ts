import { OVClient } from "./client.js";
import { OpenVikingProvider } from "./provider.js";
import type { OVConfig } from "./config.js";
import type { MemoryRequestContext } from "../../core/contracts.js";
import type { MemoryMessage } from "../../core/provider.js";
import type { LlmCompleteFn } from "../../core/llm-extractor.js";

/**
 * Backend adapter for the nightly sweep (OpenViking).
 *
 * Unlike the Viking API, memories are written as `viking://~/memories/<fp>.md`
 * and the fingerprint already embeds the workspace id, so the client config is
 * shared and only the request context changes per workspace.
 */
export function createOpenVikingNightlyProvider(config: OVConfig) {
  return async (_workspaceId: string, _context: MemoryRequestContext, complete?: LlmCompleteFn | null) => {
    const scoped: OVConfig = { ...config, workspacePeer: false };
    const instance = new OpenVikingProvider(new OVClient(scoped), scoped);
    if (complete) instance.setPilotComplete(complete);
    return instance as unknown as {
      curateBatch: (batch: MemoryMessage[], sessionId: string, context: MemoryRequestContext) => Promise<{ handled: boolean; count: number; rejected: number; error?: string }>;
      setPilotComplete: (complete: LlmCompleteFn | null) => void;
    };
  };
}
