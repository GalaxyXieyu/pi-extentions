import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { OVClient } from "./client.js";
import type { SyncManager } from "./sync.js";
import type { OpenVikingProvider } from "./provider.js";
import type { MemoryRequestContext } from "../../core/contracts.js";
import { listPendingReviews, resolveReview } from "../../core/runtime.js";
import { createMemoryCardRenderer, type MemoryCardOptions } from "../../core/tui/output-view.js";

export function registerTools(pi: any, client: OVClient, sync?: SyncManager, provider?: OpenVikingProvider, context?: () => MemoryRequestContext, cardOptions?: MemoryCardOptions): void {
  const card = cardOptions ? createMemoryCardRenderer(undefined, cardOptions) : undefined;
  const cardResult = card ? { renderResult: card } : {};
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Semantic search over the OpenViking knowledge base. Returns ranked results with viking:// URIs and abstracts.",
    promptSnippet: "Search OpenViking for past decisions, preferences, and project knowledge",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      scope: Type.Optional(Type.String({ description: "Viking URI prefix to scope search" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const results = provider
        ? await provider.search(params.query, { limit: params.limit ?? 10, context: context?.() })
        : await client.find(params.query, { targetUri: params.scope, topK: params.limit ?? 10 });
      if (!results.length) return { content: [{ type: "text", text: "No results found." }] };
      const maxChars = client.cfg.recallMaxContentChars;
      const lines = results.map((r: any) => {
        const content = r.abstract || r.content || "";
        const source = r.uri || r.source || r.id || "unknown";
        return `[${Number(r.score || 0).toFixed(2)}] ${source}\n  ${content.slice(0, maxChars)}${content.length > maxChars ? "..." : ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }], details: { results } };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description: "Read content at a viking:// URI at abstract, overview, or full level.",
    promptSnippet: "Read OpenViking content at a viking:// URI",
    parameters: Type.Object({ uri: Type.String(), level: StringEnum(["abstract", "overview", "full"] as const) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const auth = requirePermission(context?.(), "memory:recall");
      if (!auth.ok) return { content: [{ type: "text", text: auth.error }] };
      const content = params.level === "abstract" ? await client.abstract(params.uri) : params.level === "overview" ? await client.overview(params.uri) : await client.readContent(params.uri);
      return { content: [{ type: "text", text: content || `No content at ${params.uri}` }], details: { uri: params.uri, level: params.level, empty: !content } };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_browse",
    label: "Memory Browse",
    description: "Browse OpenViking without modifying remote data.",
    promptSnippet: "Browse the OpenViking viking:// tree",
    parameters: Type.Object({ action: StringEnum(["list", "stat"] as const), uri: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const auth = requirePermission(context?.(), "memory:recall");
      if (!auth.ok) return { content: [{ type: "text", text: auth.error }] };
      const uri = params.uri ?? "viking://";
      if (params.action === "stat") return { content: [{ type: "text", text: JSON.stringify(await client.stat(uri), null, 2) }], details: { uri, action: "stat" } };
      const entries = await client.ls(uri);
      return { content: [{ type: "text", text: entries.length ? entries.map((e) => `${e.isDir ? "dir" : "file"} ${e.name}`).join("\n") : `Empty directory: ${uri}` }], details: { uri, action: "list", count: entries.length } };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact in OpenViking through the current session for later extraction on commit.",
    promptSnippet: "Store a durable fact in OpenViking",
    parameters: Type.Object({ content: Type.String(), category: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      if (!sync?.sessionId) return { content: [{ type: "text", text: "OpenViking session is not ready." }] };
      const category = params.category ?? "general";
      const result = provider
        ? await provider.remember(params.content, { kind: category, sessionId: sync.sessionId, context: context?.() })
        : { accepted: await client.addMessage(sync.sessionId, "user", `[Remember - ${category}] ${params.content}`) };
      if (!result.accepted) return { content: [{ type: "text", text: result.error || "OpenViking memory write failed." }], isError: true };
      return { content: [{ type: "text", text: "Remembered in OpenViking." }], details: { success: true, category } };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_add_resource",
    label: "Memory Add Resource",
    description: "Ingest a URL into OpenViking. This writes remote data and requires an explicit user request.",
    promptSnippet: "Ingest a URL into OpenViking",
    parameters: Type.Object({ url: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const auth = requirePermission(context?.(), "memory:resource-write");
      if (!auth.ok) return { content: [{ type: "text", text: auth.error }] };
      const result = await client.addResource(params.url);
      if (!result) return { content: [{ type: "text", text: `Failed to ingest: ${params.url}` }], isError: true };
      return { content: [{ type: "text", text: `Ingested: ${result.root_uri}` }], details: result };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_archive_expand",
    label: "Memory Archive Expand",
    description: "Read an archived OpenViking session overview without modifying remote data.",
    promptSnippet: "Expand an archived OpenViking session",
    parameters: Type.Object({ archive_id: Type.Optional(Type.String()), session_id: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const auth = requirePermission(context?.(), "memory:recall");
      if (!auth.ok) return { content: [{ type: "text", text: auth.error }] };
      const sid = params.session_id ?? params.archive_id;
      if (!sid) return { content: [{ type: "text", text: "Provide session_id or archive_id." }] };
      const uri = `viking://session/${sid}`;
      const content = await client.overview(uri) || await client.overview(`${uri}/history`);
      return { content: [{ type: "text", text: content || `Archive not found: ${sid}` }], details: { uri, sessionId: sid, empty: !content } };
    },
    ...cardResult,
  });

  pi.registerTool({
    name: "memory_review",
    label: "Memory Pending Review",
    description: "List or resolve pending memory contradictions flagged for user confirmation. Use 'list' to inspect, then 'accept-new' (new fact wins), 'keep-old' (existing memory wins), or 'merge' (combine both).",
    promptSnippet: "Review pending OpenViking memory contradictions",
    parameters: Type.Object({
      action: StringEnum(["list", "accept-new", "keep-old", "merge"] as const),
      fingerprint: Type.Optional(Type.String({ description: "Fingerprint of the pending review (from 'list')" })),
    }),
    async execute(_id: string, params: any) {
      const loopContext = context?.();
      if (!loopContext) return { content: [{ type: "text", text: "memory request context is unavailable" }] };
      if (params.action === "list") {
        const pending = listPendingReviews(loopContext.identity);
        if (!pending.length) return { content: [{ type: "text", text: "No pending memory reviews." }], details: { count: 0 } };
        const lines = pending.map((entry, index) => `#${index} fingerprint=${entry.fingerprint}
  kind=${entry.record.kind} scope=${entry.record.scope} status=${entry.record.status}
  content: ${entry.record.content.slice(0, 300)}
  contradicts: ${(entry.record.contradicts || []).join(", ") || "(none)"}`);
        return { content: [{ type: "text", text: lines.join("\n\n") }], details: { count: pending.length, fingerprints: pending.map((e) => e.fingerprint) } };
      }
      if (!params.fingerprint) return { content: [{ type: "text", text: "fingerprint is required for accept-new / keep-old / merge" }], isError: true };
      const resolved = resolveReview({ fingerprint: String(params.fingerprint) }, params.action as "accept-new" | "keep-old" | "merge");
      if (!resolved.ok) return { content: [{ type: "text", text: resolved.error || "review resolution failed" }], isError: true };
      return { content: [{ type: "text", text: `Resolved (${params.action}): ${resolved.record?.content.slice(0, 120)}` }], details: { action: params.action, fingerprint: params.fingerprint } };
    },
    ...cardResult,
  });
}

function requirePermission(context: MemoryRequestContext | undefined, permission: string): { ok: boolean; error?: string } {
  if (!context) return { ok: false, error: "memory request context is unavailable" };
  if (!context.permissions.includes(permission) && !context.permissions.includes("memory:admin")) return { ok: false, error: `permission-denied:${permission}` };
  return { ok: true };
}
