import test from "node:test";
import assert from "node:assert/strict";
import { filterRecall, gateCapture, auditReceipt } from "../runtime.ts";
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
