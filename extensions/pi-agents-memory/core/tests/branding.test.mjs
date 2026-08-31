import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMemoryCommand, LEGACY_COMMAND_ALIASES } from "../command-registry.js";
import { localMemoryStatePath, localMemoryStateDir, migrateStateDir } from "../local-paths.js";

function fakePi() {
  const registered = {};
  return {
    registered,
    registerCommand(name, definition) {
      if (registered[name]) throw new Error(`duplicate command ${name}`);
      registered[name] = definition;
    },
  };
}

test("canonical /memory* commands also bind the legacy /viking names", () => {
  const pi = fakePi();
  const bound = registerMemoryCommand(pi, "memory-consolidate", { description: "x", handler: async () => {} });
  assert.deepEqual([...bound].sort(), ["memory-consolidate", "viking-consolidate", "viking-memory-consolidate"].sort());
  assert.match(pi.registered["viking-consolidate"].description, /旧命令名/);
  assert.equal(typeof pi.registered["memory-consolidate"].handler, "function");
});

test("legacy aliases cover both providers' old command names", () => {
  const aliases = Object.values(LEGACY_COMMAND_ALIASES).flat();
  for (const legacy of ["viking-memory", "viking", "viking-memory-stats", "viking-memory-audit", "viking-capabilities", "viking-nightly", "viking-memory-nightly"]) {
    assert.ok(aliases.includes(legacy), `${legacy} must stay reachable after the rename`);
  }
});

test("a conflicting alias never blocks the canonical command", () => {
  const pi = fakePi();
  pi.registerCommand("viking-memory", { description: "taken", handler: async () => {} });
  const bound = registerMemoryCommand(pi, "memory", { description: "status", handler: async () => {} });
  assert.deepEqual([...bound].sort(), ["memory", "viking"]);
  assert.equal(pi.registered["viking-memory"].description, "taken", "an occupied alias is left alone");
});

test("state directory moves from pi-viking-memory to pi-agents-memory once", () => {
  const home = join(tmpdir(), `pi-brand-${Math.random().toString(36).slice(2, 8)}`);
  const legacy = join(home, ".pi", "agent", "pi-viking-memory");
  const target = join(home, ".pi", "agent", "pi-agents-memory");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "lifecycle.json"), JSON.stringify({ version: 1, entries: [] }));
  const previousHome = process.env.HOME;
  const previousState = process.env.PI_MEMORY_STATE_DIR;
  process.env.HOME = home;
  delete process.env.PI_MEMORY_STATE_DIR;
  try {
    assert.equal(localMemoryStatePath("lifecycle.json"), join(target, "lifecycle.json"));
    assert.equal(existsSync(join(legacy, "lifecycle.json")), false, "legacy directory was moved, not copied");
    assert.equal(statSync(join(localMemoryStateDir(), "lifecycle.json")).size > 0, true, "the ledger survived the rename");
    localMemoryStateDir();
    assert.equal(existsSync(localMemoryStateDir()), true, "second call is a no-op");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousState !== undefined) process.env.PI_MEMORY_STATE_DIR = previousState;
    rmSync(home, { recursive: true, force: true });
  }
});

test("migration refuses to overwrite an existing target directory", () => {
  const base = join(tmpdir(), `pi-brand2-${Math.random().toString(36).slice(2, 8)}`);
  const legacy = join(base, "pi-viking-memory");
  const target = join(base, "pi-agents-memory");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(legacy, "keep.txt"), "old");
  writeFileSync(join(target, "keep.txt"), "new");
  assert.equal(migrateStateDir(legacy, target), false);
  assert.equal(existsSync(join(legacy, "keep.txt")), true, "legacy data stays put when the target already exists");
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "new");
  rmSync(base, { recursive: true, force: true });
});

test("PI_MEMORY_STATE_DIR still wins over the default location", () => {
  const custom = join(tmpdir(), `pi-brand-env-${Math.random().toString(36).slice(2, 8)}`);
  const previous = process.env.PI_MEMORY_STATE_DIR;
  process.env.PI_MEMORY_STATE_DIR = custom;
  try {
    assert.equal(localMemoryStatePath("nightly-state.json"), join(custom, "nightly-state.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_STATE_DIR; else process.env.PI_MEMORY_STATE_DIR = previous;
  }
});

test("the nightly sweep resolves the pi CLI even with launchd's bare PATH", async () => {
  const { resolvePiCli } = await import("../nightly.js");
  const home = join(tmpdir(), `pi-cli-${Math.random().toString(36).slice(2, 8)}`);
  const bin = join(home, ".workbuddy/binaries/node/versions/22.0.0/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
  const found = resolvePiCli("pi", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, home);
  assert.equal(found, join(bin, "pi"), "found under the version-nested bin directory");
  assert.equal(resolvePiCli("/definitely/not/here", {}, home), null, "an explicit bad path is reported as missing");
  rmSync(home, { recursive: true, force: true });
});

test("the nightly sweep ships its own TS loader (tests/ is not published)", () => {
  const root = join(import.meta.dirname, "..", "..");
  const script = readFileSync(join(root, "scripts/nightly-sweep.mjs"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(!/\.\.\/tests\/|providers\/\*\/tests/.test(script), "the sweep must not import test-only resolvers");
  assert.ok(script.includes("./lib/register-loader.mjs"), "the sweep registers the shipped loader");
  for (const file of ["scripts/lib/register-loader.mjs", "scripts/lib/ts-resolver.mjs"]) {
    assert.ok(existsSync(join(root, file)), `${file} must exist`);
  }
  assert.ok(pkg.files.includes("scripts/lib/*.mjs"), "package files allowlist must ship scripts/lib");
});
