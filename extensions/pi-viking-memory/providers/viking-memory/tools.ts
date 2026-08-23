import { Type } from "typebox";
import type { VikingMemoryConfig } from "./config.js";
import type { VikingMemoryProvider } from "./provider.js";

export function registerTools(pi: any, provider: VikingMemoryProvider, config: VikingMemoryConfig, sessionId: () => string): void {
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
      const items = await provider.search(params.query, { limit: params.limit ?? config.recallLimit });
      return { content: [{ type: "text", text: items.length ? JSON.stringify(items, null, 2) : "No results found." }], details: items };
    },
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
      const result = await provider.remember(params.content, { kind: "event", sessionId: sessionId() });
      if (!result.accepted) return { content: [{ type: "text", text: result.error || "Viking Memory request failed." }] };
      return { content: [{ type: "text", text: "Remembered in remote Viking Memory." }], details: result.raw };
    },
  });

  pi.registerTool({
    name: "viking_memory_profile",
    label: "Viking Memory Profile",
    description: "Upsert the current user profile in remote Viking Memory.",
    promptSnippet: "Update the user profile in remote Viking Memory",
    parameters: Type.Object({
      profile: Type.String({ description: "Profile information to store" }),
    }),
    async execute(_id: string, params: any) {
      const result = await provider.updateProfile(params.profile);
      if (!result.accepted) return { content: [{ type: "text", text: result.error || "Viking Memory request failed." }] };
      return { content: [{ type: "text", text: "Profile updated in remote Viking Memory." }], details: result.raw };
    },
  });
}

function errorText(response: any): string {
  return response?.message ? `Viking Memory request failed: ${response.message}` : "Viking Memory is not configured or reachable.";
}
