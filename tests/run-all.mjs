import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const loader = join(repoRoot, "extensions/pi-viking-memory/tests/register-loader.mjs");
const patterns = [
  "extensions/pi-viking-memory/core/tests/*.test.mjs",
  "extensions/pi-viking-memory/providers/openviking/tests/*.test.mjs",
  "extensions/pi-viking-memory/providers/viking-memory/tests/*.test.mjs",
];
const files = [];
for (const pattern of patterns) {
  const dir = join(repoRoot, pattern.slice(0, pattern.lastIndexOf("/")));
  const { stdout } = spawnSync("find", [dir, "-maxdepth", "1", "-type", "f", "-name", "*.test.mjs", "-print"], { encoding: "utf8" });
  files.push(...stdout.trim().split("\n").filter(Boolean));
}
const args = ["--experimental-strip-types", "--import", loader, "--test", ...files];
const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: repoRoot });
process.exit(result.status ?? 1);
