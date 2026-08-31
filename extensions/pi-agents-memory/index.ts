import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSelected } from "./core/selection.js";
import { loadCanonicalConfig } from "./core/config-protocol.js";

export type EnabledBackend = "viking-memory" | "openviking";

/**
 * A single plugin entry that selects exactly one backend (from environment/config)
 * and delegates to its provider bootstrap. No two backends are ever activated
 * together, so there is no double-write.
 *
 * Common platform concerns (versioned config, identity resolution, policy,
 * lifecycle ledger, observability) live below the backend in core/ and are wired
 * by each provider bootstrap via loadCanonicalConfig / resolverFromEnv / runtime.
 */
export function resolveBackend(): { backend: EnabledBackend | null; canonicalValid: boolean } {
  const canonical = loadCanonicalConfig();
  if (!canonical.valid) return { backend: null, canonicalValid: false };
  const backend = (process.env.PI_MEMORY_BACKEND || "").toLowerCase() as EnabledBackend | "";
  if (backend === "viking-memory" || backend === "openviking") {
    if (!isSelected(backend)) return { backend: null, canonicalValid: true };
    return { backend, canonicalValid: true };
  }
  return { backend: null, canonicalValid: true };
}

export default async function (pi: ExtensionAPI) {
  const { backend, canonicalValid } = resolveBackend();
  if (!canonicalValid) return;
  if (backend === "viking-memory") return import("./providers/viking-memory/index.js").then((m) => m.default(pi));
  if (backend === "openviking") return import("./providers/openviking/index.js").then((m) => m.default(pi));
  return;
}

export function selectedProviderId(): EnabledBackend | null {
  return resolveBackend().backend;
}
