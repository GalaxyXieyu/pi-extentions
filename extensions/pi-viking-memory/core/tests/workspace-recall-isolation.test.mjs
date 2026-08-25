import { test } from "vitest";
import assert from "node:assert/strict";
import { localIdentity, requestContext } from "../contracts.ts";
import { filterRecall } from "../runtime.ts";
import { GLOBAL_MEMORY_GROUP } from "../workspace-identity.ts";

const identity = localIdentity({ tenantId: "tenant-a", userId: "alice", workspaceId: "ws-project-a" });
const context = requestContext(identity);

function item(kind, workspace, content) {
  return {
    kind,
    id: `${workspace}-${kind}`,
    content,
    source: "test",
    scope: kind === "profile" ? "user" : "workspace",
    metadata: { tenant_id: "tenant-a", user_id: "alice", workspace_id: workspace, status: "active", confidence: "high" },
  };
}

test("recall admits current-project memory and explicit global profiles only", () => {
  const current = item("project", "ws-project-a", "this project uses pnpm");
  const otherProject = item("project", "ws-project-b", "other project uses yarn");
  const globalProfile = item("profile", GLOBAL_MEMORY_GROUP, "answers should be concise");
  const otherProfile = item("profile", "ws-project-b", "other project's preference");
  const foreignUser = { ...item("project", "ws-project-a", "foreign"), metadata: { tenant_id: "tenant-a", user_id: "bob", workspace_id: "ws-project-a" } };

  const result = filterRecall([current, otherProject, globalProfile, otherProfile, foreignUser], context);
  assert.deepEqual(result.items.map((value) => value.content).sort(), ["answers should be concise", "this project uses pnpm"]);
  assert.equal(result.dropped, 3);
});