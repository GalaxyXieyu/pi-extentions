import type { MemoryBackendId } from "./provider.js";

/**
 * Both plugins may be installed, but only the selected backend may perform
 * automatic recall/capture. This prevents duplicate writes and contradictory
 * context injection when a user has both extensions in ~/.pi/agent.
 */
export function selectedBackend(env: NodeJS.ProcessEnv = process.env): MemoryBackendId | null {
  const value = String(env.PI_MEMORY_BACKEND || "").trim().toLowerCase();
  if (value === "viking-memory" || value === "viking") return "viking-memory";
  if (value === "openviking" || value === "ov") return "openviking";
  return null;
}

export function isSelected(id: MemoryBackendId, env: NodeJS.ProcessEnv = process.env): boolean {
  return selectedBackend(env) === id;
}
