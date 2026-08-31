import test from "node:test";
import assert from "node:assert/strict";
import { filterRecall, gateCapture, auditReceipt, formatConflictPreview, curateWithLlm } from "../runtime.ts";
import { localIdentity, requestContext } from "../contracts.ts";

test("runtime pipeline rejects unauthorized capture and filters recall lifecycle", async () => {
  const identity = localIdentity({ userId: "alice", workspaceId: "ws-test" });
  const denied = await gateCapture("请记住这个项目事实", identity, { ...requestContext(identity), permissions: ["memory:recall"] });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /permission-denied/);
  const context = requestContext(identity);
  const result = filterRecall([
    { kind: "project", content: "allowed", metadata: { user_id: "alice", tenant_id: "local", workspace_id: "ws-test", status: "active" } },
    { kind: "project", content: "wrong user", metadata: { user_id: "bob", tenant_id: "local", workspace_id: "ws-test" } },
    { kind: "event", content: "expired", metadata: { user_id: "alice", tenant_id: "local", workspace_id: "ws-test", valid_until: "2000-01-01T00:00:00Z" } },
  ], context);
  assert.deepEqual(result.items.map((item) => item.content), ["allowed"]);
  assert.equal(result.dropped, 2);
});

test("audit receipt is produced from runtime path", () => {
  const identity = localIdentity({ userId: "alice" });
  const receipt = auditReceipt("session_1", identity, []);
  assert.match(receipt, /session_1/);
  assert.match(receipt, /alice/);
});

test("formatConflictPreview strips markdown and collapses whitespace", () => {
  assert.equal(formatConflictPreview("**结论:更新不能自动装**", 40), "结论:更新不能自动装");
  assert.equal(formatConflictPreview("`code` and [link](http://x) here", 40), "code and link here");
  assert.equal(formatConflictPreview(undefined, 40), "(无内容)");
  assert.equal(formatConflictPreview("", 40), "(无内容)");
  // long text is clipped with an ellipsis, not raw-sliced
  const long = "x".repeat(80);
  const out = formatConflictPreview(long, 20);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 20);
});

test("curateWithLlm drops low-confidence noise but keeps high-confidence facts", async () => {
  const identity = localIdentity({ userId: "u1", workspaceId: "ws" });
  const context = requestContext(identity);
  const complete = async () => JSON.stringify({
    memories: [
      { action: "add", text: "这次先不自动装", kind: "preference", scope: "user", confidence: 0.3 },
      { action: "add", text: "以后都用 pnpm 装依赖", kind: "preference", scope: "user", confidence: 0.9 },
    ],
  });
  const result = await curateWithLlm([{ role: "user", content: "这次先不自动装,以后都用 pnpm" }], identity, context, async () => [], complete);
  assert.equal(result.handled, true);
  assert.equal(result.decisions.length, 1);
  assert.match(result.decisions[0].candidate.content, /以后都用 pnpm/);
});
