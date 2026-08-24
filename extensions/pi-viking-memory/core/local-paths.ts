import { homedir } from "node:os";
import { join } from "node:path";

export function localMemoryStatePath(name: string): string {
  return join(process.env.PI_MEMORY_STATE_DIR || join(homedir(), ".pi", "agent", "pi-viking-memory"), name);
}
