import { existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = "pi-agents-memory";
const LEGACY_STATE_DIRS = ["pi-viking-memory"];

/**
 * Local state directory, migrated once from the pre-rename `pi-viking-memory`
 * path. The lifecycle ledger and the nightly cursor live here, so a rename is
 * not cosmetic: losing the directory would forget every dedupe fingerprint and
 * re-create memories that already exist.
 */
export function localMemoryStateDir(): string {
  const configured = process.env.PI_MEMORY_STATE_DIR;
  if (configured) return configured;
  const base = join(homedir(), ".pi", "agent");
  const current = join(base, STATE_DIR);
  for (const legacy of LEGACY_STATE_DIRS) {
    const candidate = join(base, legacy);
    if (migrateStateDir(candidate, current)) break;
  }
  return current;
}

/** Atomic one-time move; never overwrites an existing target. */
export function migrateStateDir(from: string, to: string): boolean {
  try {
    if (!existsSync(from) || !statSync(from).isDirectory()) return false;
    if (existsSync(to)) return false;
    renameSync(from, to);
    return true;
  } catch {
    // Read-only home, concurrent startup, or an exotic filesystem: fall back to
    // the existing directory rather than starting a second ledger.
    return false;
  }
}

export function localMemoryStatePath(name: string): string {
  return join(localMemoryStateDir(), name);
}
