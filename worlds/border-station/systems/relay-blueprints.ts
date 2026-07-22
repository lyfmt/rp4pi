import { defineSystem } from "../../../src/systems/define-system.ts";

type RelayBlueprint = {
  id: string;
  parts: string[];
  stability: number;
};

type RelayBlueprintState = {
  blueprints: RelayBlueprint[];
};

type CreateBlueprintInput = RelayBlueprint;

const BLUEPRINT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function parseRelayBlueprintState(payload: unknown): RelayBlueprintState {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("relay-blueprints state must be an object");
  }

  const { blueprints } = payload as { blueprints?: unknown };
  if (!Array.isArray(blueprints)) {
    throw new TypeError("relay-blueprints state.blueprints must be an array");
  }

  const parsedBlueprints: RelayBlueprint[] = [];
  const ids = new Set<string>();
  for (const value of blueprints) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("relay-blueprints state entry must be an object");
    }

    const { id, parts, stability } = value as {
      id?: unknown;
      parts?: unknown;
      stability?: unknown;
    };
    if (typeof id !== "string" || !BLUEPRINT_ID_PATTERN.test(id)) {
      throw new TypeError("relay-blueprints blueprint id must be a slug");
    }
    if (
      !Array.isArray(parts) ||
      parts.length === 0 ||
      parts.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      throw new TypeError("relay-blueprints blueprint parts must be a non-empty string array");
    }
    if (typeof stability !== "number" || !Number.isFinite(stability) || stability < 0 || stability > 1) {
      throw new TypeError("relay-blueprints blueprint stability must be a finite number between 0 and 1");
    }
    if (ids.has(id)) {
      throw new TypeError(`relay-blueprints state has duplicate blueprint id: ${id}`);
    }
    ids.add(id);
    parsedBlueprints.push({ id, parts: [...parts], stability });
  }

  return { blueprints: parsedBlueprints };
}

function parseCreateBlueprintInput(input: unknown): CreateBlueprintInput {
  return parseRelayBlueprintState({ blueprints: [input] }).blueprints[0]!;
}

export const relayBlueprints = defineSystem<RelayBlueprintState>({
  name: "relay-blueprints",
  version: 1,
  initialize: () => ({ blueprints: [] }),
  parse: parseRelayBlueprintState,
  commands: {
    create: {
      parseInput: parseCreateBlueprintInput,
      execute(_context, state, input) {
        const parsedInput = input as CreateBlueprintInput;
        const blueprint = { ...parsedInput, parts: [...parsedInput.parts] };
        const nextState = parseRelayBlueprintState({
          blueprints: [...state.blueprints, blueprint]
        });
        return {
          nextState,
          result: { id: blueprint.id, accepted: true }
        };
      }
    }
  },
  project(_context, state) {
    return {
      count: state.blueprints.length,
      blueprints: state.blueprints.map(({ id, parts, stability }) => ({
        id,
        partCount: parts.length,
        stability
      }))
    };
  }
});
