#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Install / remove the launchd job that runs the nightly memory sweep.
 *
 *   node scripts/install-nightly.mjs                 # 00:00 local, every day
 *   node scripts/install-nightly.mjs --hour 3 --minute 30
 *   node scripts/install-nightly.mjs --dry-run       # print the plist only
 *   node scripts/install-nightly.mjs --uninstall
 *   node scripts/install-nightly.mjs --status
 *
 * Secrets never go into the plist. The job sources
 * ~/.pi/agent/pi-agents-memory/nightly.env (mode 0600) first, and this
 * installer seeds that file from the memory-related variables in your current
 * shell — run it from a terminal where PI_MEMORY_BACKEND and the API key are
 * already exported.
 */

const LABEL = "com.pi.agents-memory.nightly";
const LEGACY_LABELS = ["com.pi.viking-memory.nightly"];
const LEGACY_PLISTS = LEGACY_LABELS.map((label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`));
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "nightly-sweep.mjs");
const stateDir = join(homedir(), ".pi", "agent", "pi-agents-memory");
const envFile = join(stateDir, "nightly.env");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const args = parseArgs(process.argv.slice(2));

const hour = clamp(args.hour ?? process.env.PI_MEMORY_NIGHTLY_HOUR ?? 0, 0, 23);
const minute = clamp(args.minute ?? process.env.PI_MEMORY_NIGHTLY_MINUTE ?? 0, 0, 59);
const node = process.env.PI_MEMORY_NIGHTLY_NODE || process.execPath;

if (args.uninstall) {
  for (const label of [LABEL, ...LEGACY_LABELS]) run("launchctl", ["bootout", `gui/${uid()}/${label}`]);
  for (const file of [plistPath, ...LEGACY_PLISTS]) {
    if (existsSync(file)) {
      spawnSync("rm", [file]);
      console.log(`removed ${file}`);
    }
  }
  console.log("nightly sweep uninstalled (nightly.env and the ledger are kept)");
  process.exit(0);
}

if (args.status) {
  const result = run("launchctl", ["print", `gui/${uid()}/${LABEL}`], { capture: true });
  console.log(result.stdout || result.stderr || `${LABEL} is not loaded`);
  process.exit(result.status === 0 ? 0 : 1);
}

if (!existsSync(scriptPath)) {
  console.error(`nightly-sweep.mjs not found next to this script: ${scriptPath}`);
  process.exit(1);
}

const body = plist({
  label: LABEL,
  command: ["/bin/zsh", "-lc", zshCommand()],
  hour,
  minute,
  outPath: join(stateDir, "nightly.out"),
  errPath: join(stateDir, "nightly.err"),
  workingDirectory: dirname(dirname(scriptPath)),
});

if (args.dryRun) {
  if (args.printEnv) console.log(renderEnv(envLines()));
  console.log(body);
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true });
mkdirSync(dirname(plistPath), { recursive: true });
// The pre-rename job pointed at a directory that no longer exists; retire it
// before installing the new one so only one sweep runs at 00:00.
for (const label of LEGACY_LABELS) run("launchctl", ["bootout", `gui/${uid()}/${label}`], { capture: true });
for (const legacy of LEGACY_PLISTS) if (existsSync(legacy)) spawnSync("rm", [legacy]);

const seeded = writeEnvFile();
writeFileSync(plistPath, body, "utf8");
chmodSync(plistPath, 0o644);
run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { capture: true });
// launchd unloads asynchronously: bootstrapping the same label too early fails
// with "Bootstrap failed: 5", which looks like a broken plist but is not.
waitForUnload();
let loaded = run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath], { capture: true });
if (loaded.status !== 0) {
  waitForUnload(3000);
  loaded = run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath], { capture: true });
}
if (loaded.status !== 0) {
  // Last resort: the legacy load syntax still works for user agents.
  loaded = run("launchctl", ["load", "-w", plistPath], { capture: true });
}
if (loaded.status !== 0) {
  console.error(`launchctl bootstrap failed:\n${loaded.stderr || loaded.stdout}`);
  process.exit(1);
}

function waitForUnload(budgetMs = 1500) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const probe = run("launchctl", ["print", `gui/${uid()}/${LABEL}`], { capture: true });
    if (probe.status !== 0) return;
    spawnSync("sleep", ["0.15"]);
  }
}

console.log(`installed ${plistPath}`);
if (seeded) console.log(`wrote ${envFile} (mode 0600) from the current shell env — edit it if that list is wrong`);
console.log(`sweep runs daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} local`);
console.log(`  node   ${node}`);
console.log(`  script ${scriptPath}`);
console.log(`  log    ${join(stateDir, "nightly.log")}`);
console.log(`try it now: launchctl kickstart -k gui/${uid()}/${LABEL}`);

function zshCommand() {
  const lines = [
    // launchd hands the job a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
    // The sweep needs both node (shebang) and the pi CLI, so pin what we
    // resolved at install time instead of discovering "no model" at 00:00.
    `export PATH=${quote([dirname(node), dirname(piCli()), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"))}:$PATH`,
    `if [ -f ${quote(envFile)} ]; then set -a; . ${quote(envFile)}; set +a; fi`,
    `export PI_MEMORY_NIGHTLY_LOG=${quote(join(stateDir, "nightly.log"))}`,
    `export PI_MEMORY_NIGHTLY_CLI=${quote(piCli())}`,
    `export PI_MEMORY_NIGHTLY_NODE=${quote(node)}`,
    `exec ${quote(node)} --experimental-strip-types --no-warnings ${quote(scriptPath)}`,
  ];
  return lines.join(" && ");
}

/** Absolute path to the pi CLI, resolved when the job is installed. */
function piCli() {
  const configured = process.env.PI_MEMORY_NIGHTLY_CLI || "";
  if (configured.includes("/")) return configured;
  const found = run("/bin/zsh", ["-lc", "command -v pi"], { capture: true });
  const path = String(found.stdout || "").trim().split("\n").pop() || "";
  if (path) return path;
  // pi is normally a sibling of the running node binary, which is the one case
  // that keeps working when launchd hands us a bare PATH.
  const sibling = join(dirname(node), "pi");
  if (existsSync(sibling)) return sibling;
  return configured || "pi";
}

function writeEnvFile() {
  const lines = envLines();
  if (!lines.length) return false;
  if (existsSync(envFile) && !args.forceEnv) {
    console.log(`${envFile} already exists — left untouched (pass --force-env to overwrite)`);
    return false;
  }
  writeFileSync(envFile, renderEnv(lines), "utf8");
  chmodSync(envFile, 0o600);
  return true;
}

function envLines() {
  const keys = Object.keys(process.env)
    .filter((key) => /^(PI_MEMORY_|MEMORY_|VIKING_|OPENVIKING_|OV_)/.test(key))
    .filter((key) => !["PI_MEMORY_NIGHTLY_LOG", "PI_MEMORY_NIGHTLY_NODE", "PI_MEMORY_NIGHTLY_CLI"].includes(key))
    .sort();
  const lines = keys.map((key) => [key, String(process.env[key])]);
  // Pin the resolved binaries so a scheduled run cannot lose them to PATH.
  lines.push(["PI_MEMORY_NIGHTLY_NODE", node]);
  lines.push(["PI_MEMORY_NIGHTLY_CLI", piCli()]);
  return lines.sort((a, b) => a[0].localeCompare(b[0]));
}

function renderEnv(lines) {
  return ["# Generated by pi-agents-memory install-nightly.mjs — nightly sweep env.", ...lines.map(([k, v]) => `${k}=${quote(v)}`), ""].join("\n");
}

function plist(options) {
  const entry = (key, value) => `  <key>${key}</key>\n${value}`;
  const strings = (list) => list.map((item) => `      <string>${escape(String(item))}</string>`).join("\n");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    entry("Label", `  <string>${options.label}</string>`),
    entry("ProgramArguments", `  <array>\n${strings(options.command)}\n    </array>`),
    entry("RunAtLoad", "  <false/>"),
    entry("StartCalendarInterval", `  <dict>\n      <key>Hour</key>\n      <integer>${options.hour}</integer>\n      <key>Minute</key>\n      <integer>${options.minute}</integer>\n    </dict>`),
    entry("WorkingDirectory", `  <string>${escape(options.workingDirectory)}</string>`),
    entry("StandardOutPath", `  <string>${escape(options.outPath)}</string>`),
    entry("StandardErrorPath", `  <string>${escape(options.errPath)}</string>`),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function escape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", ...options });
  if (!options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--uninstall") out.uninstall = true;
    else if (token === "--status") out.status = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--force-env") out.forceEnv = true;
    else if (token === "--print-env") out.printEnv = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}
