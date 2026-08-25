import { test } from "vitest";
import assert from "node:assert/strict";
import { OpenVikingProvider } from "../provider.ts";
import { requestContext, localIdentity } from "../../../core/contracts.ts";

function config() {
  return { endpoint: "https://example.invalid", account: "pi-local", user: "pi", peerId: "local", recallLimit: 10, recallQueryExpansion: "off", scoreThreshold: 0.3, captureToolResults: false, captureAssistantTurns: true, captureMaxLength: 24000 };
}

test("OpenViking supersede/merge updates a found viking:// memory via writeContent and persists supersession", async () => {
  const previous = process.env.PI_MEMORY_LIFECYCLE_FILE;
  process.env.PI_MEMORY_LIFECYCLE_FILE = `:memory:${Math.random()}`;
  const written = { uri: undefined, content: "" };
  const client = {
    health: async () => true,
    searchContext: async () => ({ memories: [{ uri: "viking://~/memories/refactor.md", abstract: "修复了缓存问题", context_type: "event", category: "workspace", score: 0.95 }] }),
    writeContent: async (uri, content, opts) => { written.uri = uri; written.content = content; return { uri, root_uri: "viking://~/memories" }; },
    addMessage: async () => true,
    addMessageParts: async () => true,
    createSession: async () => true,
  };
  const provider = new OpenVikingProvider(client, config());
  const context = requestContext(localIdentity({ userId: "pi", workspaceId: "local" }), { lifecycle: { expiryEnabled: true, conflictPolicy: "auto-merge" } });
  const result = await provider.capture("s1", [{ role: "user", content: "完成了缓存重建" }], context);
  if (previous === undefined) delete process.env.PI_MEMORY_LIFECYCLE_FILE; else process.env.PI_MEMORY_LIFECYCLE_FILE = previous;
  assert.equal(result.accepted, true);
  assert.equal(written.uri, "viking://~/memories/refactor.md");
  assert.match(written.content, /缓存/);
});