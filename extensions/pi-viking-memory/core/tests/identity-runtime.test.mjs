import { test } from "vitest";
import assert from "node:assert/strict";
import { resolverFromEnv, localIdentity } from "../contracts.ts";

test("identity resolver is a real injectable runtime contract", async () => {
  const resolver = resolverFromEnv({ MEMORY_IDENTITY_SOURCE: "env", VIKING_MEMORY_USER_ID: "alice", MEMORY_TENANT_ID: "tenant-a" });
  const identity = await resolver.resolve({ cwd: process.cwd(), env: { VIKING_MEMORY_USER_ID: "alice", MEMORY_TENANT_ID: "tenant-a" } });
  assert.equal(identity.userId, "alice");
  assert.equal(identity.tenantId, "tenant-a");
  assert.equal(identity.developmentFallback, true);
});
