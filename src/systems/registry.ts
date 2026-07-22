import { isSystemDefinition } from "./define-system.ts";
import { SystemRuntimeError } from "./errors.ts";
import type { SystemDefinition } from "./types.ts";

export type SystemRegistry = Readonly<{
  names(): readonly string[];
  definitions(): readonly SystemDefinition<unknown>[];
  require(name: string): SystemDefinition<unknown>;
  hasCapability(name: string): boolean;
}>;

export type CreateSystemRegistryOptions = Readonly<{
  capabilities: ReadonlyMap<string, unknown>;
}>;

export function createSystemRegistry(
  definitions: readonly SystemDefinition<unknown>[],
  options: CreateSystemRegistryOptions
): SystemRegistry {
  const byName = new Map<string, SystemDefinition<unknown>>();
  const capabilityNames = new Set(options.capabilities.keys());

  for (const definition of definitions) {
    if (!isSystemDefinition(definition)) {
      throw new SystemRuntimeError("REGISTRATION_INVALID", {
        reason: "system definition must be created with defineSystem"
      });
    }
    if (byName.has(definition.name)) {
      throw new SystemRuntimeError("REGISTRATION_INVALID", {
        system: definition.name,
        reason: "duplicate system name"
      });
    }
    byName.set(definition.name, definition);
  }

  for (const definition of definitions) {
    for (const dependency of definition.dependsOn) {
      if (!byName.has(dependency)) {
        throw new SystemRuntimeError("DEPENDENCY_UNAVAILABLE", {
          system: definition.name,
          dependency
        });
      }
    }
    for (const capability of definition.capabilities) {
      if (!capabilityNames.has(capability)) {
        throw new SystemRuntimeError("CAPABILITY_UNAVAILABLE", {
          system: definition.name,
          capability
        });
      }
    }
  }

  const ordered = orderDefinitions(definitions, byName);
  const orderedNames = Object.freeze(ordered.map((definition) => definition.name));
  const orderedDefinitions = Object.freeze([...ordered]);

  return Object.freeze({
    names: () => orderedNames,
    definitions: () => orderedDefinitions,
    require(name: string) {
      const definition = byName.get(name);
      if (definition === undefined) {
        throw new SystemRuntimeError("SYSTEM_NOT_REGISTERED", { system: name });
      }
      return definition;
    },
    hasCapability: (name: string) => capabilityNames.has(name)
  });
}

function orderDefinitions(
  definitions: readonly SystemDefinition<unknown>[],
  byName: ReadonlyMap<string, SystemDefinition<unknown>>
): SystemDefinition<unknown>[] {
  const ordered: SystemDefinition<unknown>[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (definition: SystemDefinition<unknown>, path: readonly string[]): void => {
    if (visited.has(definition.name)) {
      return;
    }
    if (visiting.has(definition.name)) {
      const cycleStart = path.indexOf(definition.name);
      throw new SystemRuntimeError("REGISTRATION_INVALID", {
        system: definition.name,
        cycle: [...path.slice(cycleStart), definition.name],
        reason: "dependency cycle"
      });
    }

    visiting.add(definition.name);
    const nextPath = [...path, definition.name];
    for (const dependencyName of definition.dependsOn) {
      visit(byName.get(dependencyName)!, nextPath);
    }
    visiting.delete(definition.name);
    visited.add(definition.name);
    ordered.push(definition);
  };

  for (const definition of definitions) {
    visit(definition, []);
  }
  return ordered;
}
