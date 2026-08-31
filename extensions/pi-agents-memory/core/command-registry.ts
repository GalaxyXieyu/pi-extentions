/**
 * Command registration with legacy aliases.
 *
 * The plugin used to be called pi-viking-memory and every slash command
 * carried that prefix. The canonical surface is now `/memory*`; the old names
 * stay registered as thin aliases for one major version so muscle memory and
 * existing key bindings keep working. Alias descriptions say so explicitly
 * instead of silently duplicating help text.
 */

export const LEGACY_COMMAND_ALIASES: Record<string, string[]> = {
  memory: ["viking-memory", "viking"],
  "memory-stats": ["viking-memory-stats"],
  "memory-audit": ["viking-memory-audit"],
  "memory-capabilities": ["viking-memory-capabilities", "viking-capabilities"],
  "memory-workspace": ["viking-memory-workspace"],
  "memory-consolidate": ["viking-memory-consolidate", "viking-consolidate"],
  "memory-nightly": ["viking-memory-nightly", "viking-nightly"],
};

export interface MemoryCommandDefinition {
  description?: string;
  handler: (args: string, ctx: any) => void | Promise<void>;
  [key: string]: unknown;
}

/** Register `name` plus any legacy aliases. Returns the names actually bound. */
export function registerMemoryCommand(pi: any, name: string, definition: MemoryCommandDefinition): string[] {
  const bound: string[] = [];
  const attach = (target: string, description?: string) => {
    try {
      pi.registerCommand(target, description ? { ...definition, description } : definition);
      bound.push(target);
      return true;
    } catch {
      // A conflicting alias must never stop the plugin from loading.
      return false;
    }
  };

  attach(name);
  for (const alias of LEGACY_COMMAND_ALIASES[name] || []) {
    attach(alias, `${definition.description || ""}（旧命令名,等价的 /${name}）`);
  }
  return bound;
}
