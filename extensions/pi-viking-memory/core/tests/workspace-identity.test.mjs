import { test } from "vitest";
import assert from "node:assert/strict";
import { canonicalizeGitRemote, GLOBAL_MEMORY_GROUP, resolveWorkspaceIdentity } from "../workspace-identity.ts";

test("Git remote canonicalization treats SSH and HTTPS clones as the same repository", () => {
  assert.equal(canonicalizeGitRemote("git@github.com:acme/platform.git"), "github.com/acme/platform");
  assert.equal(canonicalizeGitRemote("https://github.com/acme/platform.git"), "github.com/acme/platform");
});

test("workspace identity prefers an explicit cross-device override", () => {
  const identity = resolveWorkspaceIdentity({ cwd: "/tmp/untracked", explicitId: "Acme-Platform-Production" });
  assert.deepEqual(identity, { id: "acme-platform-production", source: "explicit" });
});

test("workspace identity has an isolated deterministic cwd fallback", () => {
  const first = resolveWorkspaceIdentity({ cwd: "/tmp/local-only-project" });
  const second = resolveWorkspaceIdentity({ cwd: "/tmp/local-only-project" });
  const other = resolveWorkspaceIdentity({ cwd: "/tmp/other-project" });
  assert.equal(first.source, "cwd");
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, other.id);
  assert.equal(GLOBAL_MEMORY_GROUP, "__pi_global__");
});