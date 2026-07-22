import { createRequire } from "node:module";

import { isSystemDefinition } from "./define-system.ts";
import type { SystemDefinition } from "./types.ts";

const requireSystemModule = createRequire(import.meta.url);

export function loadSystemDefinitions(modulePaths: readonly string[]): SystemDefinition<unknown>[] {
  const definitions: SystemDefinition<unknown>[] = [];
  const seen = new Set<SystemDefinition<unknown>>();

  for (const modulePath of modulePaths) {
    let loaded: Record<string, unknown>;
    try {
      loaded = requireSystemModule(modulePath) as Record<string, unknown>;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to load System module ${modulePath}: ${detail}`, { cause });
    }

    const moduleDefinitions = Object.values(loaded).filter(isSystemDefinition);
    if (moduleDefinitions.length === 0) {
      throw new Error(`System module exported no SystemDefinition: ${modulePath}`);
    }

    for (const definition of moduleDefinitions) {
      if (!seen.has(definition)) {
        seen.add(definition);
        definitions.push(definition);
      }
    }
  }

  return definitions;
}
