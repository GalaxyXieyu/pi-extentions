import { test } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCredentialFiles, resolveOpenVikingCredentials } from "../shared/credentials.mjs";

test("credentials loader rejects group-readable config files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-credentials-security-"));
  const path = join(dir, "ov.conf");
  await writeFile(path, JSON.stringify({ server: { root_api_key: "file-secret" } }));
  await chmod(path, 0o644);
  const old = process.env.OPENVIKING_CONFIG_FILE;
  process.env.OPENVIKING_CONFIG_FILE = path;
  try {
    const files = loadCredentialFiles(process.env);
    assert.equal(files.ovFile.server, undefined);
    assert.notEqual(resolveOpenVikingCredentials(process.env).apiKey, "file-secret");
  } finally {
    if (old === undefined) delete process.env.OPENVIKING_CONFIG_FILE;
    else process.env.OPENVIKING_CONFIG_FILE = old;
  }
});
