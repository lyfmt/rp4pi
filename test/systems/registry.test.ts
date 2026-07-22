import assert from "node:assert/strict";
import test from "node:test";

import { defineSystem } from "../../src/systems/define-system.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";
import { createSystemRegistry } from "../../src/systems/registry.ts";

function system(
  name: string,
  options: { dependsOn?: string[]; capabilities?: string[] } = {}
) {
  return defineSystem({
    name,
    version: 1,
    dependsOn: options.dependsOn,
    capabilities: options.capabilities,
    initialize: () => ({ value: 0 }),
    parse: (payload: unknown) => payload as { value: number },
    commands: {},
    project: (_context, state) => state
  });
}

test("registry orders declared dependencies before dependants", () => {
  const generatorSystem = system("generator");
  const questSystem = system("quest", { dependsOn: ["generator"] });

  const registry = createSystemRegistry([questSystem, generatorSystem], {
    capabilities: new Map()
  });

  assert.deepEqual(registry.names(), ["generator", "quest"]);
  assert.deepEqual(registry.definitions(), [generatorSystem, questSystem]);
  assert.equal(registry.require("quest"), questSystem);
});

test("registry keeps declaration order between independent systems", () => {
  const second = system("second");
  const first = system("first");

  const registry = createSystemRegistry([second, first], { capabilities: new Map() });

  assert.deepEqual(registry.names(), ["second", "first"]);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.names()), true);
  assert.equal(Object.isFrozen(registry.definitions()), true);
});

test("registry rejects duplicate system names", () => {
  assert.throws(
    () => createSystemRegistry([system("quest"), system("quest")], { capabilities: new Map() }),
    (error) =>
      error instanceof SystemRuntimeError &&
      error.code === "REGISTRATION_INVALID" &&
      error.context.system === "quest"
  );
});

test("registry rejects an unavailable dependency", () => {
  assert.throws(
    () => createSystemRegistry([system("quest", { dependsOn: ["generator"] })], { capabilities: new Map() }),
    (error) =>
      error instanceof SystemRuntimeError &&
      error.code === "DEPENDENCY_UNAVAILABLE" &&
      error.context.system === "quest" &&
      error.context.dependency === "generator"
  );
});

test("registry rejects dependency cycles", () => {
  assert.throws(
    () =>
      createSystemRegistry(
        [system("quest", { dependsOn: ["generator"] }), system("generator", { dependsOn: ["quest"] })],
        { capabilities: new Map() }
      ),
    (error) => error instanceof SystemRuntimeError && error.code === "REGISTRATION_INVALID"
  );
});

test("registry rejects requested capabilities that have no adapter", () => {
  assert.throws(
    () => createSystemRegistry([system("gacha", { capabilities: ["rng"] })], { capabilities: new Map() }),
    (error) =>
      error instanceof SystemRuntimeError &&
      error.code === "CAPABILITY_UNAVAILABLE" &&
      error.context.system === "gacha" &&
      error.context.capability === "rng"
  );
});

test("registry exposes only capability availability", () => {
  const adapter = { next: () => 4 };
  const registry = createSystemRegistry([system("gacha", { capabilities: ["rng"] })], {
    capabilities: new Map([["rng", adapter]])
  });

  assert.equal(registry.hasCapability("rng"), true);
  assert.equal(registry.hasCapability("jobs"), false);
  assert.equal("register" in registry, false);
});

test("registry require rejects missing systems instead of returning undefined", () => {
  const registry = createSystemRegistry([], { capabilities: new Map() });

  assert.throws(
    () => registry.require("missing"),
    (error) =>
      error instanceof SystemRuntimeError &&
      error.code === "SYSTEM_NOT_REGISTERED" &&
      error.context.system === "missing"
  );
});
