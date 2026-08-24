import test from "node:test";
import assert from "node:assert/strict";
import { localIdentity, requestContext } from "../contracts.ts";
import { loadCanonicalConfig } from "../config-protocol.ts";

test("local identity is explicit and marked as development fallback", () => {
  const identity = localIdentity();
  assert.equal(identity.tenantId, "local");
  assert.equal(identity.userId, "user_01");
  assert.equal(identity.developmentFallback, true);
  assert.equal(requestContext(identity).purpose, "coding");
});

test("invalid versioned config is rejected", async () => {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "memory-config-invalid-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, revision: "", backend: "bad" }));
  const { loadCanonicalConfig } = await import("../config-protocol.ts");
  const result = loadCanonicalConfig({ MEMORY_CONFIG_FILE: path, PI_MEMORY_BACKEND: "viking-memory" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
  await rm(dir, { recursive: true, force: true });
});

test("canonical config keeps backend selection and revision", () => {
  const result = loadCanonicalConfig({ PI_MEMORY_BACKEND: "viking-memory", VIKING_MEMORY_USER_ID: "alice" });
  assert.equal(result.valid, true);
  assert.equal(result.config.backend, "viking-memory");
  assert.equal(result.config.identity.userId, "alice");
  assert.match(result.config.revision, /^local-/);
  assert.equal(result.config.credentialRef, "env://MEMORY_API_KEY");
});
