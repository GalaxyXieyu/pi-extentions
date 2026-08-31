import { VikingMemoryClient } from "./client.js";
import { VikingMemoryProvider } from "./provider.js";
import type { VikingMemoryConfig } from "./config.js";
import type { MemoryRequestContext } from "../../core/contracts.js";
import type { MemoryMessage } from "../../core/provider.js";
import type { LlmCompleteFn } from "../../core/llm-extractor.js";

/**
 * Backend adapter for the nightly sweep: one provider instance per workspace,
 * because the Viking API scopes memories by `group_id` and the group comes from
 * the client config. Keeping this next to the provider means both the in-pi
 * entry (`/memory-nightly`, the headless job) and the standalone dev script
 * share one construction path instead of each guessing the config shape.
 */
export function createVikingNightlyProvider(config: VikingMemoryConfig) {
  return async (workspaceId: string, _context: MemoryRequestContext, complete?: LlmCompleteFn | null) => {
    const scoped: VikingMemoryConfig = { ...config, groupId: workspaceId };
    const instance = new VikingMemoryProvider(new VikingMemoryClient(scoped), scoped);
    if (complete) instance.setPilotComplete(complete);
    return instance as unknown as {
      curateBatch: (batch: MemoryMessage[], sessionId: string, context: MemoryRequestContext) => Promise<{ handled: boolean; count: number; rejected: number; error?: string }>;
      setPilotComplete: (complete: LlmCompleteFn | null) => void;
    };
  };
}
