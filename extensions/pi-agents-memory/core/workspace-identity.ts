import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type WorkspaceIdentitySource = "explicit" | "git-remote" | "cwd";

export interface WorkspaceIdentity {
  id: string;
  source: WorkspaceIdentitySource;
  repositoryRoot?: string;
  canonicalRemote?: string;
}

/** Reserved backend group for user-wide preferences and durable profile facts. */
export const GLOBAL_MEMORY_GROUP = "__pi_global__";

/**
 * Resolve a stable project workspace identity with no manual setup in normal
 * Git repositories. A Git remote survives different clones and paths across
 * computers; a local cwd hash is deliberately isolated until the user opts in.
 */
export function resolveWorkspaceIdentity(options: { cwd?: string; explicitId?: string } = {}): WorkspaceIdentity {
  const cwd = resolve(options.cwd || process.cwd());
  const explicitId = normalizeId(options.explicitId || process.env.PI_MEMORY_WORKSPACE_ID || process.env.MEMORY_WORKSPACE_ID || "");
  if (explicitId) return { id: explicitId, source: "explicit" };

  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const remote = root ? git(root, ["config", "--get", "remote.origin.url"]) : "";
  const canonicalRemote = canonicalizeGitRemote(remote);
  if (canonicalRemote) {
    const slug = normalizeId(basename(canonicalRemote).replace(/\.git$/i, "")) || "repo";
    return { id: `ws-${slug}-${shortHash(canonicalRemote)}`, source: "git-remote", repositoryRoot: root || undefined, canonicalRemote };
  }

  const slug = normalizeId(basename(root || cwd)) || "local";
  return { id: `ws-${slug}-${shortHash(root || cwd)}`, source: "cwd", repositoryRoot: root || undefined };
}

export function canonicalizeGitRemote(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // scp-like Git syntax: git@github.com:org/repo.git
  const scp = raw.includes("://") ? null : raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  const url = scp ? `ssh://${scp[1]}/${scp[2]}` : raw;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return path ? `${host}/${path}` : host;
  } catch {
    return raw.replace(/^.*@/, "").replace(/:/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  }
}

export function isGlobalMemoryGroup(groupId: string | undefined): boolean {
  return String(groupId || "") === GLOBAL_MEMORY_GROUP;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeId(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
