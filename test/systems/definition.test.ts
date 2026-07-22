import assert from "node:assert/strict";
import test from "node:test";

import { defineSystem, isSystemDefinition } from "../../src/systems/define-system.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";

function parseProgression(payload: unknown): { level: number; xp: number; perks: string[] } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("progression payload must be an object");
  }
  const candidate = payload as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.level) ||
    !Number.isInteger(candidate.xp) ||
    !Array.isArray(candidate.perks) ||
    !candidate.perks.every((perk) => typeof perk === "string")
  ) {
    throw new Error("invalid progression payload");
  }
  return candidate as { level: number; xp: number; perks: string[] };
}

function validDefinitionInput() {
  return {
    name: "progression",
    version: 2,
    initialize: () => ({ level: 1, xp: 0, perks: [] as string[] }),
    parse: parseProgression,
    migrate: (_fromVersion: number, payload: unknown) => ({ version: 2, payload }),
    commands: {
      gain_xp: {
        parseInput: (input: unknown) => input,
        execute: (_context: unknown, state: Readonly<{ level: number; xp: number; perks: string[] }>, input: unknown) => ({
          nextState: { ...state, xp: state.xp + Number(input) },
          result: null
        })
      }
    },
    project: (_context: unknown, state: Readonly<{ level: number; xp: number; perks: string[] }>) => state
  };
}

test("defineSystem preserves module-owned lifecycle and freezes the definition", () => {
  const definition = defineSystem(validDefinitionInput());

  assert.equal(definition.name, "progression");
  assert.equal(definition.version, 2);
  assert.deepEqual(definition.dependsOn, []);
  assert.deepEqual(definition.capabilities, []);
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.dependsOn), true);
  assert.equal(Object.isFrozen(definition.capabilities), true);
  assert.equal(Object.isFrozen(definition.commands), true);
  assert.equal(Object.isFrozen(definition.commands.gain_xp), true);
  assert.equal(isSystemDefinition(definition), true);
});

test("defineSystem copies author-owned arrays and command maps before freezing", () => {
  const dependsOn = ["generator"];
  const capabilities = ["rng"];
  const command = {
    parseInput: (input: unknown) => input,
    execute: () => ({ nextState: {}, result: null })
  };
  const commands: Record<string, typeof command> = { advance: command };
  const definition = defineSystem({
    ...validDefinitionInput(),
    dependsOn,
    capabilities,
    commands
  });

  dependsOn.push("quest");
  capabilities.push("jobs");
  commands.extra = command;

  assert.deepEqual(definition.dependsOn, ["generator"]);
  assert.deepEqual(definition.capabilities, ["rng"]);
  assert.deepEqual(Object.keys(definition.commands), ["advance"]);
  assert.notEqual(definition.commands.advance, command);
});

test("defineSystem rejects invalid names with structured registration errors", () => {
  assert.throws(
    () => defineSystem({ ...validDefinitionInput(), name: "Bad Name" }),
    (error) =>
      error instanceof SystemRuntimeError &&
      error.code === "REGISTRATION_INVALID" &&
      error.context.system === "Bad Name"
  );
});

test("defineSystem rejects non-positive and non-integer versions", () => {
  for (const version of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => defineSystem({ ...validDefinitionInput(), version }),
      (error) => error instanceof SystemRuntimeError && error.code === "REGISTRATION_INVALID"
    );
  }
});

test("defineSystem rejects empty and malformed command keys", () => {
  const command = validDefinitionInput().commands.gain_xp;
  for (const key of ["", "Bad Command"]) {
    assert.throws(
      () => defineSystem({ ...validDefinitionInput(), commands: { [key]: command } }),
      (error) => error instanceof SystemRuntimeError && error.code === "REGISTRATION_INVALID"
    );
  }
});

test("isSystemDefinition rejects objects that did not pass the definition factory", () => {
  assert.equal(isSystemDefinition({ ...validDefinitionInput(), dependsOn: [], capabilities: [] }), false);
});
