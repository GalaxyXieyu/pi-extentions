import test from "node:test";
import assert from "node:assert/strict";
import { VikingMemoryProvider } from "../provider.ts";
import { localIdentity, requestContext } from "../../../core/contracts.ts";

function config() {
  return { endpoint: "https://example.invalid", apiKey: "x", collectionName: "piAgent", projectName: "default", userId: "user_01", assistantId: "pi", groupId: "ws-pi-extentions-5d074fd50585", recallLimit: 10, scoreThreshold: 0.35 };
}

test("Viking search parses real API result_list shape and array user_id", async () => {
  const client = {
    search: async () => ({
      code: 0,
      data: {
        result_list: [{
          id: "event-1",
          group_id: "ws-pi-extentions-5d074fd50585",
          user_id: ["user_01"],
          assistant_id: ["pi"],
          memory_type: "event_v1",
          score: 0.325,
          memory_info: { summary: "项目使用 TypeScript" },
        }],
      },
    }),
    health: async () => true,
    getContext: async () => ({ code: 0, data: {} }),
  };
  const provider = new VikingMemoryProvider(client, config());
  const context = requestContext(localIdentity({ userId: "user_01", workspaceId: "ws-pi-extentions-5d074fd50585" }));
  const items = await provider.search("TypeScript", { context });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "event-1");
  assert.equal(items[0].kind, "event");
  assert.equal(items[0].metadata.user_id, "user_01");
  assert.equal(items[0].metadata.workspace_id, "ws-pi-extentions-5d074fd50585");
});
