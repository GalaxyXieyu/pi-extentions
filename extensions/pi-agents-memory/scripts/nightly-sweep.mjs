#!/usr/bin/env node
import { register } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Developer entry point for the nightly sweep.
 *
 * The scheduled job does NOT use this: launchd runs a headless pi with
 * PI_MEMORY_NIGHTLY_RUN=1 (see scripts/install-nightly.mjs), because Node
 * refuses to type-strip TypeScript inside node_modules and an npm install of
 * this plugin lives exactly there. Use this script only from a repo checkout,
 * e.g. to curate one workspace by hand:
 *
 *   node --experimental-strip-types scripts/nightly-sweep.mjs --since-hours 6
 *
 * Model source here: PI_MEMORY_LLM_URL when set, otherwise a nested
 * `pi -p --no-session --no-tools` subprocess.
 */

const here = new URL("./", import.meta.url);
register(new URL("./lib/ts-resolver.mjs", here).href, import.meta.url);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`usage: nightly-sweep.mjs [--since-hours N] [--dry-run] [--limit N] [--window-chars N] [--max-windows N] [--backend viking-memory|openviking] [--model provider/model] [--no-consolidate]`);
  process.exit(0);
}

const { loadCanonicalConfig } = await import("../core/config-protocol.js");
const { runNightlyInProcess } = await import("../core/nightly-runner.js");
const { makePiCliComplete } = await import("../core/nightly.js");
const { llmEndpoint, llmExtractionEnabled } = await import("../core/llm-extractor.js");

const logFile = args.log || process.env.PI_MEMORY_NIGHTLY_LOG;
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  if (logFile) {
    try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, `${text}\n`); } catch { /* logging never breaks the sweep */ }
  }
};

const canonical = loadCanonicalConfig(process.env);
if (!canonical.valid) fail(`config invalid: ${canonical.errors.join("; ")}`);
const backend = args.backend || canonical.config.backend;
if (!backend) fail("PI_MEMORY_BACKEND is not set");
if (!llmExtractionEnabled()) fail("PI_MEMORY_LLM_ENABLED=0 disables every model path, including this sweep");

const { config, providerFor } = await buildBackend(backend, log);
const complete = llmEndpoint() ? null : makePiCliComplete({ model: args.model });
log(complete ? "llm via nested pi CLI (dev entry)" : `llm via endpoint ${llmEndpoint()}`);

const { report } = await runNightlyInProcess({
  sinceHours: args.sinceHours ? Number(args.sinceHours) : undefined,
  limit: args.limit ? Number(args.limit) : undefined,
  windowChars: args.windowChars ? Number(args.windowChars) : undefined,
  maxWindowsPerFile: args.maxWindows ? Number(args.maxWindows) : undefined,
  dryRun: Boolean(args.dryRun),
  consolidate: args.consolidate !== false,
  base: { userId: config.userId || config.user, agentId: config.assistantId || "pi" },
  complete,
  providerFor,
  log,
});
process.exit(report.errors.length && !report.processed ? 1 : 0);

async function buildBackend(id, logger) {
  if (id === "viking-memory") {
    const { loadConfigFromModuleUrl } = await import("../providers/viking-memory/config.js");
    const { createVikingNightlyProvider } = await import("../providers/viking-memory/nightly.js");
    const base = loadConfigFromModuleUrl(new URL("../providers/viking-memory/index.ts", here).href);
    applyCanonical(base);
    if (!base.apiKey) fail("MEMORY_API_KEY is not set — the sweep cannot write memories");
    return { config: base, providerFor: createVikingNightlyProvider(base) };
  }
  const { loadConfigFromModuleUrl } = await import("../providers/openviking/config.js");
  const { createOpenVikingNightlyProvider } = await import("../providers/openviking/nightly.js");
  const base = loadConfigFromModuleUrl(new URL("../providers/openviking/index.ts", here).href);
  applyCanonical(base);
  logger(`openviking backend at ${base.url || process.env.OPENVIKING_URL || "config default"}`);
  return { config: base, providerFor: createOpenVikingNightlyProvider(base) };
}

function applyCanonical(target) {
  const c = canonical.config;
  target.recallLimit = c.retrieval.limit;
  target.recallTokenBudget = c.retrieval.maxChars;
  target.minQueryLength = c.retrieval.minQueryLength;
  if ("scoreThreshold" in target) target.scoreThreshold = c.retrieval.scoreThreshold ?? target.scoreThreshold;
  if ("captureMaxLength" in target) target.captureMaxLength = c.capture.maxLength;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--no-consolidate") out.consolidate = false;
    else if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

function fail(message) {
  console.error(`[nightly-sweep] ${message}`);
  process.exit(1);
}
