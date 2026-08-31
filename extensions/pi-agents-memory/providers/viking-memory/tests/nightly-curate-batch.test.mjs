import test from "node:test";
import assert from "node:assert/strict";
import { VikingMemoryProvider } from "../provider.ts";
import { requestContext, localIdentity } from "../../../core/contracts.ts";

function config() {
  return { endpoint: "https://example.invalid", apiKey: "x", collectionName: "piAgent", projectName: "default", userId: "alice", assistantId: "pi", groupId: "workspace-a", recallLimit: 10, scoreThreshold: 0.35 };
}

function stubClient() {
  const calls = { addEvent: [], addProfile: [], updateEvent: [], addSession: [], search: [] };
  return {
    calls,
    search: async (query) => { calls.search.push(query); return { code: 0, data: { events: [{ id: "e-existing", event_id: "e-existing", memory_info: { summary: "包管理采用 npm" }, tags: { user_id: ["alice"], tenant_id: "local", group_id: "workspace-a" } }] } }; },
    addEvent: async (summary, sessionId) => { calls.addEvent.push({ summary, sessionId }); return { code: 0, data: { event_id: `e-${calls.addEvent.length}` } }; },
    addProfile: async (profile) => { calls.addProfile.push(profile); return { code: 0, data: { profile_id: `p-${calls.addProfile.length}` } }; },
    updateEvent: async (id, summary) => { calls.updateEvent.push({ id, summary }); return { code: 0, data: {} }; },
    updateProfile: async () => ({ code: 0, data: {} }),
    addSession: async (_session, messages) => { calls.addSession.push(messages); return { code: 0, message: "success" }; },
    health: async () => true,
  };
}

function contextFor() {
  const identity = localIdentity({ tenantId: "local", userId: "alice", workspaceId: "workspace-a" });
  return requestContext(identity);
}

const isolatedLedger = async (fn) => {
  const previous = process.env.PI_MEMORY_LIFECYCLE_FILE;
  process.env.PI_MEMORY_LIFECYCLE_FILE = `:memory:${Math.random()}`;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_LIFECYCLE_FILE;
    else process.env.PI_MEMORY_LIFECYCLE_FILE = previous;
  }
};

test("rule-miss messages never invoke the model during capture by default", async () => {
  delete process.env.PI_MEMORY_LLM_INLINE;
  process.env.PI_MEMORY_LLM_ENABLED = "1";
  await isolatedLedger(async () => {
    const client = stubClient();
    const provider = new VikingMemoryProvider(client, config());
    let llmCalls = 0;
    provider.setPilotComplete(async () => { llmCalls++; return '{"memories":[]}'; });
    const result = await provider.capture("session-a", [
      { role: "user", content: "这套工具链太折腾了，新的一套顺手很多" },
      { role: "assistant", content: "确实，旧的配置项太多了" },
      { role: "user", content: "感觉这个思路更贴合我们的用法" },
      { role: "assistant", content: "嗯，后面再看看别的方案" },
      { role: "user", content: "这个界面看着舒服一些" },
    ], contextFor());
    assert.equal(result.accepted, true);
    assert.equal(llmCalls, 0, "capture must not wait on a model");
    assert.equal(client.calls.addEvent.length, 0, "nothing durable written behind the rules");
    assert.equal(client.calls.addSession.length >= 1, true, "messages still sync to the backend session");
  });
  delete process.env.PI_MEMORY_LLM_ENABLED;
});

test("PI_MEMORY_LLM_INLINE=1 restores the in-session batch funnel", async () => {
  process.env.PI_MEMORY_LLM_INLINE = "1";
  process.env.PI_MEMORY_LLM_BATCH_COUNT = "2";
  await isolatedLedger(async () => {
    const client = stubClient();
    const provider = new VikingMemoryProvider(client, config());
    let llmCalls = 0;
    provider.setPilotComplete(async () => {
      llmCalls++;
      return JSON.stringify({ memories: [{ action: "add", text: "偏好轻量工具链", kind: "preference", scope: "user", confidence: 0.9 }] });
    });
    await provider.capture("session-a", [
      { role: "user", content: "这套工具链太折腾了，新的一套顺手很多" },
      { role: "user", content: "旧的太重了，新的顺手很多" },
    ], contextFor());
    assert.equal(llmCalls, 1);
    assert.equal(client.calls.addProfile.length, 1, "global preference goes to the profile API");
  });
  delete process.env.PI_MEMORY_LLM_INLINE;
  delete process.env.PI_MEMORY_LLM_BATCH_COUNT;
  delete process.env.PI_MEMORY_LLM_ENABLED;
});

test("curateBatch applies nightly decisions through the same write API", async () => {
  await isolatedLedger(async () => {
    const client = stubClient();
    const provider = new VikingMemoryProvider(client, config());
    provider.setPilotComplete(async () => JSON.stringify({
      memories: [
        { action: "add", text: "以后测试命令用 pnpm test", kind: "preference", scope: "user", confidence: 0.95 },
        { action: "add", text: "这个仓库用 pnpm workspace，入口 packages/*", kind: "project", scope: "workspace", confidence: 0.9 },
        { action: "noop", text: "今天先这样", kind: "event", confidence: 0.9 },
      ],
    }));
    const result = await provider.curateBatch([{ role: "user", content: "以后测试命令用 pnpm test" }], "nightly_sess", contextFor());
    assert.equal(result.handled, true);
    assert.equal(result.count, 2);
    assert.equal(result.decisions.filter((d) => d.decision === "add").length, 2);
    assert.equal(client.calls.addProfile.length, 1);
    assert.equal(client.calls.addEvent.length, 1);
    assert.equal(client.calls.addEvent[0].sessionId, "nightly_sess");
  });
});

test("curateBatch reports unhandled when no completion source exists", async () => {
  await isolatedLedger(async () => {
    const provider = new VikingMemoryProvider(stubClient(), config());
    delete process.env.PI_MEMORY_LLM_URL;
    const result = await provider.curateBatch([{ role: "user", content: "x" }], "nightly_sess", contextFor());
    assert.equal(result.handled, false);
    assert.equal(result.count, 0);
  });
});
