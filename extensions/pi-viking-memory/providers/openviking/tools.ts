import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { OVClient } from "./client.js";
import type { SyncManager } from "./sync.js";
import type { OpenVikingProvider } from "./provider.js";

export function registerTools(pi: any, client: OVClient, sync?: SyncManager, provider?: OpenVikingProvider): void {
  pi.registerTool({
    name: "viking_search",
    label: "Viking Search",
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
        ? await provider.search(params.query, { limit: params.limit ?? 10 })
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
  });

  pi.registerTool({
    name: "viking_read",
    label: "Viking Read",
    description: "Read content at a viking:// URI at abstract, overview, or full level.",
    promptSnippet: "Read OpenViking content at a viking:// URI",
    parameters: Type.Object({ uri: Type.String(), level: StringEnum(["abstract", "overview", "full"] as const) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const content = params.level === "abstract" ? await client.abstract(params.uri) : params.level === "overview" ? await client.overview(params.uri) : await client.readContent(params.uri);
      return { content: [{ type: "text", text: content || `No content at ${params.uri}` }] };
    },
  });

  pi.registerTool({
    name: "viking_browse",
    label: "Viking Browse",
    description: "Browse OpenViking without modifying remote data.",
    promptSnippet: "Browse the OpenViking viking:// tree",
    parameters: Type.Object({ action: StringEnum(["list", "stat"] as const), uri: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const uri = params.uri ?? "viking://";
      if (params.action === "stat") return { content: [{ type: "text", text: JSON.stringify(await client.stat(uri), null, 2) }] };
      const entries = await client.ls(uri);
      return { content: [{ type: "text", text: entries.length ? entries.map((e) => `${e.isDir ? "dir" : "file"} ${e.name}`).join("\n") : `Empty directory: ${uri}` }] };
    },
  });

  pi.registerTool({
    name: "viking_remember",
    label: "Viking Remember",
    description: "Store a fact in OpenViking through the current session for later extraction on commit.",
    promptSnippet: "Store a durable fact in OpenViking",
    parameters: Type.Object({ content: Type.String(), category: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      if (!sync?.sessionId) return { content: [{ type: "text", text: "OpenViking session is not ready." }] };
      const category = params.category ?? "general";
      const result = provider
        ? await provider.remember(params.content, { kind: category, sessionId: sync.sessionId })
        : { accepted: await client.addMessage(sync.sessionId, "user", `[Remember - ${category}] ${params.content}`) };
      return { content: [{ type: "text", text: result.accepted ? "Remembered in OpenViking." : "OpenViking memory write failed." }], details: result };
    },
  });

  pi.registerTool({
    name: "viking_add_resource",
    label: "Viking Add Resource",
    description: "Ingest a URL into OpenViking. This writes remote data and requires an explicit user request.",
    promptSnippet: "Ingest a URL into OpenViking",
    parameters: Type.Object({ url: Type.String(), reason: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const result = await client.addResource(params.url);
      return { content: [{ type: "text", text: result ? `Ingested: ${result.root_uri}` : `Failed to ingest: ${params.url}` }], details: result };
    },
  });

  pi.registerTool({
    name: "viking_archive_expand",
    label: "Viking Archive Expand",
    description: "Read an archived OpenViking session overview without modifying remote data.",
    promptSnippet: "Expand an archived OpenViking session",
    parameters: Type.Object({ archive_id: Type.Optional(Type.String()), session_id: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any) {
      if (!client.connected) return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      const sid = params.session_id ?? params.archive_id;
      if (!sid) return { content: [{ type: "text", text: "Provide session_id or archive_id." }] };
      const uri = `viking://session/${sid}`;
      const content = await client.overview(uri) || await client.overview(`${uri}/history`);
      return { content: [{ type: "text", text: content || `Archive not found: ${sid}` }] };
    },
  });
}
