import { Type } from "typebox";
import type { VikingMemoryConfig } from "./config.js";
import type { VikingMemoryProvider } from "./provider.js";
import type { MemoryRequestContext } from "../../core/contracts.js";
import { createMemoryCardRenderer, type MemoryCardOptions } from "../../core/tui/output-view.js";

export function registerTools(
  pi: any,
  provider: VikingMemoryProvider,
  config: VikingMemoryConfig,
  sessionId: () => string,
  context: () => MemoryRequestContext,
  cardOptions?: MemoryCardOptions,
): void {
  const card = cardOptions ? createMemoryCardRenderer(undefined, cardOptions) : undefined;

  pi.registerTool({
    name: "viking_memory_search",
    label: "Viking Memory Search",
    description: "Search remote Viking long-term memories for relevant user profile and event memories.",
    promptSnippet: "Search remote Viking Memory for past preferences, events, and decisions",
    parameters: Type.Object({
      query: Type.String({ description: "Semantic search query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results, default 10" })),
    }),
    async execute(_id: string, params: any) {
      const items = await provider.search(params.query, { limit: params.limit ?? config.recallLimit, context: context() });
      return { content: [{ type: "text", text: items.length ? JSON.stringify(items, null, 2) : "No results found." }], details: { results: items } };
    },
    ...(card ? { renderResult: card } : {}),
  });

  pi.registerTool({
    name: "viking_memory_remember",
    label: "Viking Memory Remember",
    description: "Store an explicit fact in remote Viking event memory so it can be recalled in future Pi sessions.",
    promptSnippet: "Remember a durable fact in remote Viking Memory",
    parameters: Type.Object({
      content: Type.String({ description: "Fact, decision, preference, or lesson to remember" }),
    }),
    async execute(_id: string, params: any) {
      const result = await provider.remember(params.content, { kind: "event", sessionId: sessionId(), context: context() });
      if (!result.accepted) return { content: [{ type: "text", text: result.error || "Viking Memory request failed." }], isError: true };
      return { content: [{ type: "text", text: "Remembered in remote Viking Memory." }], details: { success: true, count: result.count, backend: result.backend } };
    },
    ...(card ? { renderResult: card } : {}),
  });

  pi.registerTool({
    name: "viking_memory_profile",
    label: "Viking Memory Profile",
    description: "Upsert a global user preference/profile in remote Viking Memory.",
    promptSnippet: "Update the user profile in remote Viking Memory",
    parameters: Type.Object({
      profile: Type.String({ description: "Profile information to store" }),
    }),
    async execute(_id: string, params: any) {
      const result = await provider.updateProfile(params.profile, context());
      if (!result.accepted) return { content: [{ type: "text", text: result.error || "Viking Memory request failed." }], isError: true };
      return { content: [{ type: "text", text: "Global profile updated in remote Viking Memory." }], details: { success: true, count: result.count, backend: result.backend } };
    },
    ...(card ? { renderResult: card } : {}),
  });
}
