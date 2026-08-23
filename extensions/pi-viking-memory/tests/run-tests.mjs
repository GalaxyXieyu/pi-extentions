import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(extensionRoot, "..", "..");
const loader = join(repoRoot, "extensions/pi-viking-memory/tests/register-loader.mjs");
const command = [
  "node --experimental-strip-types",
  `--import ${loader}`,
  "--test extensions/pi-viking-memory/providers/openviking/tests/*.test.mjs extensions/pi-viking-memory/providers/viking-memory/tests/*.test.mjs extensions/pi-viking-memory/core/tests/*.test.mjs",
].join(" ");
const result = spawnSync("sh", ["-c", command], { stdio: "inherit", cwd: repoRoot });
process.exit(result.status ?? 1);
