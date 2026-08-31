import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.ts";

async function withConfig(body, env, fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agents-memory-config-"));
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    await writeFile(join(dir, "config.json"), JSON.stringify(body));
    return await fn(loadConfig(dir));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("Viking config uses defaults and behavior config", async () => {
  await withConfig({ recallLimit: 7, userId: "config-user" }, {
    MEMORY_API_KEY: undefined,
    VIKING_MEMORY_COLLECTION: undefined,
    VIKING_MEMORY_USER_ID: undefined,
  }, (config) => {
    assert.equal(config.recallLimit, 7);
    assert.equal(config.userId, "config-user");
    assert.equal(config.collectionName, "piAgent");
    assert.equal(config.apiKey, "");
  });
});

test("Viking config gives non-empty environment values priority", async () => {
  await withConfig({ collectionName: "file-collection", userId: "file-user", apiKey: "file-secret" }, {
    MEMORY_API_KEY: "env-secret",
    VIKING_MEMORY_COLLECTION: "env-collection",
    VIKING_MEMORY_USER_ID: "env-user",
  }, (config) => {
    assert.equal(config.apiKey, "env-secret");
    assert.equal(config.collectionName, "env-collection");
    assert.equal(config.userId, "env-user");
  });
});
