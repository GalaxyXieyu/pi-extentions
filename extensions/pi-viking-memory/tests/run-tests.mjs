import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "..");
const result = spawnSync("corepack", ["pnpm", "test"], { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
