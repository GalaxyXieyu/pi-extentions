import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["extensions/pi-viking-memory/core", "extensions/pi-viking-memory/providers/viking-memory", "extensions/pi-viking-memory/providers/openviking"];
const files = [];
for (const root of roots) walk(root);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(ts|mjs)$/.test(entry.name)) files.push(path);
  }
}

let failures = 0;
for (const file of files.sort()) {
  const args = file.endsWith(".ts") ? ["--experimental-strip-types", "--check", file] : ["--check", file];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const status = result.status ?? 1;
  process.stdout.write(`${status === 0 ? "PASS" : "FAIL"} ${relative(process.cwd(), file)}\n`);
  if (status !== 0) {
    failures++;
    process.stdout.write(result.stderr || result.stdout || "unknown syntax error\n");
  }
}
process.stdout.write(`summary files=${files.length} failures=${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
