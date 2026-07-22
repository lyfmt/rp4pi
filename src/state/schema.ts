import type { AttributeSpec } from "../world/schema.ts";

// A world attribute value. The fixed core (player/time/scene) stays strongly
// typed below; attributes are the world-extensible slot — each world declares
// which attributes exist and their bounds via AttributeSpec. State-level parsing
// only enforces "primitive of a known kind"; the spec-aware bounds check
// (min/max, declared type) lives in the update_attribute tool so a world can
// evolve its schema without a state migration.
export type AttributeValue = number | string | boolean;

export type RpFact = {
  id: string;
  kind: string;
  subject?: string;
  text: string;
  visibility: "public" | "gm";
  source: string;
};

export type RpRelationship = {
  source: string;
  target: string;
  stance: string;
  summary: string;
  evidence: string;
  visibility: "public" | "gm";
};

export type RpState = {
  player: {
    name: string;
    status: string;
    location: string;
  };
  time: {
    day: number;
    hour: number;
  };
  scene: {
    summary: string;
  };
  attributes: Record<string, AttributeValue>;
  facts: RpFact[];
  relationships: RpRelationship[];
};

type StateInput = Partial<{
  player: Partial<RpState["player"]>;
  time: Partial<RpState["time"]>;
  scene: Partial<RpState["scene"]>;
  attributes: Record<string, AttributeValue>;
  facts: RpFact[];
  relationships: RpRelationship[];
}>;

export function createInitialState(input: StateInput = {}, attributeSpecs: AttributeSpec[] = []): RpState {
  return parseState({
    player: {
      name: input.player?.name ?? "",
      status: input.player?.status ?? "",
      location: input.player?.location ?? ""
    },
    time: {
      day: input.time?.day ?? 1,
      hour: input.time?.hour ?? 8
    },
    scene: {
      summary: input.scene?.summary ?? ""
    },
    attributes: { ...seedAttributes(attributeSpecs), ...input.attributes },
    facts: input.facts ?? [],
    relationships: input.relationships ?? []
  });
}

/** Default attribute values declared by a world's specs. */
export function seedAttributes(attributeSpecs: AttributeSpec[]): Record<string, AttributeValue> {
  const seeded: Record<string, AttributeValue> = {};
  for (const spec of attributeSpecs) {
    seeded[spec.name] = spec.initial;
  }
  return seeded;
}

export function parseState(value: unknown): RpState {
  if (!isRecord(value)) {
    throw new TypeError("State must be an object");
  }

  const player = parseRecord(value.player, "player");
  const time = parseRecord(value.time, "time");
  const scene = parseRecord(value.scene, "scene");

  return {
    player: {
      name: parseString(player.name, "player.name"),
      status: parseString(player.status, "player.status"),
      location: parseString(player.location, "player.location")
    },
    time: {
      day: parseInteger(time.day, "time.day"),
      hour: parseHour(time.hour)
    },
    scene: {
      summary: parseString(scene.summary, "scene.summary")
    },
    // Attributes are optional at the state level so old saves (written before
    // this segment existed) hydrate cleanly as an empty map.
    attributes: parseAttributes(value.attributes),
    facts: parseFacts(value.facts),
    relationships: parseRelationships(value.relationships)
  };
}

function parseAttributes(value: unknown): Record<string, AttributeValue> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError("State field attributes must be an object");
  }
  const result: Record<string, AttributeValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" && typeof entry !== "string" && typeof entry !== "boolean") {
      throw new TypeError(`State attribute ${key} must be a number, string, or boolean`);
    }
    result[key] = entry;
  }
  return result;
}

function parseFacts(value: unknown): RpFact[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("State field facts must be an array");
  }
  return value.map((entry, index) => {
    const fact = parseRecord(entry, `facts[${index}]`);
    const parsed: RpFact = {
      id: parseString(fact.id, `facts[${index}].id`),
      kind: parseString(fact.kind, `facts[${index}].kind`),
      text: parseString(fact.text, `facts[${index}].text`),
      visibility: parseStateVisibility(fact.visibility, `facts[${index}].visibility`),
      source: parseString(fact.source, `facts[${index}].source`)
    };
    if (fact.subject !== undefined) {
      parsed.subject = parseString(fact.subject, `facts[${index}].subject`);
    }
    return parsed;
  });
}

function parseRelationships(value: unknown): RpRelationship[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("State field relationships must be an array");
  }
  return value.map((entry, index) => {
    const relationship = parseRecord(entry, `relationships[${index}]`);
    return {
      source: parseString(relationship.source, `relationships[${index}].source`),
      target: parseString(relationship.target, `relationships[${index}].target`),
      stance: parseString(relationship.stance, `relationships[${index}].stance`),
      summary: parseString(relationship.summary, `relationships[${index}].summary`),
      evidence: parseString(relationship.evidence, `relationships[${index}].evidence`),
      visibility: parseStateVisibility(relationship.visibility, `relationships[${index}].visibility`)
    };
  });
}

function parseStateVisibility(value: unknown, field: string): "public" | "gm" {
  if (value !== "public" && value !== "gm") {
    throw new TypeError(`State field ${field} must be public or gm`);
  }
  return value;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`State field ${field} must be an object`);
  }
  return value;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`State field ${field} must be a string`);
  }
  return value;
}

function parseInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`State field ${field} must be an integer`);
  }
  return value;
}

function parseHour(value: unknown): number {
  const hour = parseInteger(value, "time.hour");
  if (hour < 0 || hour > 23) {
    throw new RangeError("State field time.hour must be between 0 and 23");
  }
  return hour;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
