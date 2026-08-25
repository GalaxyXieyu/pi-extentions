import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { VikingMemoryConfig } from "./config.js";
import type { VikingMemoryProvider } from "./provider.js";
import type { MemoryRequestContext } from "../../core/contracts.js";
import { listPendingReviews, resolveReview } from "../../core/runtime.js";
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

  pi.registerTool({
    name: "viking_memory_review",
    label: "Viking Memory Pending Review",
    description: "List or resolve pending memory contradictions flagged for user confirmation. Use 'list' then 'accept-new', 'keep-old', or 'merge'.",
    promptSnippet: "Review pending Viking Memory contradictions",
    parameters: Type.Object({
      action: StringEnum(["list", "accept-new", "keep-old", "merge"] as const),
      fingerprint: Type.Optional(Type.String({ description: "Fingerprint from 'list'" })),
    }),
    async execute(_id: string, params: any) {
      const loopContext = context();
      if (!loopContext) return { content: [{ type: "text", text: "memory request context is unavailable" }] };
      if (params.action === "list") {
        const pending = listPendingReviews(loopContext.identity);
        if (!pending.length) return { content: [{ type: "text", text: "No pending memory reviews." }], details: { count: 0 } };
        const lines = pending.map((entry, index) => `#${index} fingerprint=${entry.fingerprint}\n  kind=${entry.record.kind} scope=${entry.record.scope} status=${entry.record.status}\n  content: ${entry.record.content.slice(0, 300)}\n  contradicts: ${(entry.record.contradicts || []).join(", ") || "(none)"}`);
        return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: pending.length, fingerprints: pending.map((e) => e.fingerprint) } };
      }
      if (!params.fingerprint) return { content: [{ type: "text", text: "fingerprint is required for accept-new / keep-old / merge" }], isError: true };
      const resolved = resolveReview({ fingerprint: String(params.fingerprint) }, params.action as "accept-new" | "keep-old" | "merge");
      if (!resolved.ok) return { content: [{ type: "text", text: resolved.error || "review resolution failed" }], isError: true };
      return { content: [{ type: "text", text: `Resolved (${params.action}): ${resolved.record?.content.slice(0, 120)}` }], details: { action: params.action, fingerprint: params.fingerprint } };
    },
    ...(card ? { renderResult: card } : {}),
  });
}
