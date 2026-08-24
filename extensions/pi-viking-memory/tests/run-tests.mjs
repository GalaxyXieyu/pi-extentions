import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(extensionRoot, "..", "..");
const rootLoader = join(repoRoot, "extensions/pi-viking-memory/tests/register-loader.mjs");
const ovLoader = join(repoRoot, "extensions/pi-viking-memory/providers/openviking/tests/register-loader.mjs");
const vikingLoader = join(repoRoot, "extensions/pi-viking-memory/providers/viking-memory/tests/register-loader.mjs");
const command = [
  "node --experimental-strip-types",
  `--import ${rootLoader} --import ${ovLoader} --import ${vikingLoader}`,
  "--test extensions/pi-viking-memory/providers/openviking/tests/*.test.mjs extensions/pi-viking-memory/providers/viking-memory/tests/*.test.mjs extensions/pi-viking-memory/core/tests/*.test.mjs",
].join(" ");
const result = spawnSync("sh", ["-c", command], { stdio: "inherit", cwd: repoRoot, env: { ...process.env, PI_MEMORY_STATE_DIR: mkdtempSync(join(tmpdir(), "pi-memory-test-")) } });
process.exit(result.status ?? 1);
