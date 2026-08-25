import test from "node:test";
import assert from "node:assert/strict";
import { VikingMemoryProvider } from "../provider.ts";
import { requestContext, localIdentity } from "../../../core/contracts.ts";

function config() { return { endpoint: "https://example.invalid", apiKey: "x", collectionName: "piAgent", projectName: "default", userId: "alice", assistantId: "pi", groupId: "workspace-a", recallLimit: 10, scoreThreshold: 0.35 }; }

test("Viking context capture performs lookup with current identity and writes enriched metadata", async () => {
  const previous = process.env.PI_MEMORY_LIFECYCLE_FILE;
  process.env.PI_MEMORY_LIFECYCLE_FILE = `:memory:${Math.random()}`;
  const calls = [];
  const client = {
    search: async () => ({ code: 0, data: { events: [] } }),
    addEvent: async () => ({ code: 0, data: { event_id: "e1" } }),
    addProfile: async () => ({ code: 0, data: { profile_id: "p1" } }),
    addSession: async (_session, messages) => { calls.push(messages); return { code: 0, message: "success" }; },
    getContext: async () => ({ code: 0, data: {} }),
    health: async () => true,
  };
  const provider = new VikingMemoryProvider(client, config());
  const identity = localIdentity({ tenantId: "tenant-a", userId: "alice", workspaceId: "workspace-a" });
  const context = requestContext(identity);
  const result = await provider.capture("session-a", [{ role: "user", content: "ok" }], context);
  assert.equal(result.accepted, true);
  if (previous === undefined) delete process.env.PI_MEMORY_LIFECYCLE_FILE; else process.env.PI_MEMORY_LIFECYCLE_FILE = previous;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].metadata.tenant_id, "tenant-a");
  assert.equal(calls[0][0].metadata.user_id, "alice");
});
