import { test } from "vitest";
import assert from "node:assert/strict";
import { VikingMemoryProvider } from "../provider.ts";
import { localIdentity, requestContext } from "../../../core/contracts.ts";

test("Viking merge/supersede updates the matched remote event instead of appending session text", async () => {
  const calls = { update: [], session: 0 };
  const client = {
    search: async () => ({ code: 0, data: { events: [{ event_id: "event-old", memory_type: "project", memory_info: { summary: "项目使用 npm" }, user_id: "alice", tenant_id: "local", group_id: "workspace-a" }] } }),
    updateEvent: async (id, summary) => { calls.update.push({ id, summary }); return { code: 0 }; },
    updateProfile: async () => ({ code: 0 }),
    addEvent: async () => ({ code: 0, data: {} }),
    addProfile: async () => ({ code: 0, data: {} }),
    addSession: async () => { calls.session++; return { code: 0 }; },
    getContext: async () => ({ code: 0, data: {} }),
    health: async () => true,
  };
  const provider = new VikingMemoryProvider(client, { endpoint: "x", apiKey: "x", collectionName: "c", projectName: "p", userId: "alice", assistantId: "pi", groupId: "workspace-a", recallLimit: 10, scoreThreshold: 0.35 });
  const context = requestContext(localIdentity({ userId: "alice", workspaceId: "workspace-a" }), { lifecycle: { expiryEnabled: true, conflictPolicy: "auto-merge" } });
  const result = await provider.capture("s1", [{ role: "user", content: "项目使用 pnpm，确认" }], context);
  assert.equal(result.accepted, true);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].id, "event-old");
  assert.equal(calls.session, 0);
});
