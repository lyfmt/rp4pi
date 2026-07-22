import { canonicalJson } from "../systems/canonical-json.ts";
import { SystemRuntimeError } from "../systems/errors.ts";
import type { JsonValue } from "../systems/types.ts";
import type { DynamicRole } from "./dynamic-roles.ts";
import { parseState, type RpState } from "./schema.ts";
import type { CharacterSummary } from "./trajectory.ts";

export type TrajectorySnapshot = {
  watermarks: Record<string, number>;
  summaries: CharacterSummary[];
};

export type StorySnapshotEnvelope = {
  schemaVersion: 1;
  core: { version: 1; payload: RpState };
  systems: Record<string, { version: number; payload: JsonValue }>;
  dynamicRoles: DynamicRole[];
  trajectory: TrajectorySnapshot;
  capabilities: Record<string, JsonValue>;
};

export function parseStorySnapshotEnvelope(value: unknown): StorySnapshotEnvelope {
  try {
    return parseEnvelope(value);
  } catch (cause) {
    if (cause instanceof SystemRuntimeError && cause.code === "SNAPSHOT_INCOMPATIBLE") {
      throw cause;
    }
    throw new SystemRuntimeError(
      "SNAPSHOT_INCOMPATIBLE",
      { reason: cause instanceof Error ? cause.message : "invalid snapshot envelope" },
      { cause }
    );
  }
}

function parseEnvelope(value: unknown): StorySnapshotEnvelope {
  const envelope = requireRecord(value, "snapshot");
  if (envelope.schemaVersion !== 1) {
    throw new TypeError("snapshot.schemaVersion must be 1");
  }

  const core = requireRecord(envelope.core, "snapshot.core");
  if (core.version !== 1) {
    throw new TypeError("snapshot.core.version must be 1");
  }

  return {
    schemaVersion: 1,
    core: {
      version: 1,
      payload: parseState(cloneJsonValue(core.payload, "snapshot.core.payload"))
    },
    systems: parseSystems(envelope.systems),
    dynamicRoles: parseDynamicRoles(envelope.dynamicRoles),
    trajectory: parseTrajectory(envelope.trajectory),
    capabilities: parseJsonMap(envelope.capabilities, "snapshot.capabilities")
  };
}

function parseSystems(value: unknown): StorySnapshotEnvelope["systems"] {
  const systems = requireRecord(value, "snapshot.systems");
  const parsed: StorySnapshotEnvelope["systems"] = {};

  for (const name of Object.keys(systems).sort()) {
    if (name.length === 0) {
      throw new TypeError("snapshot.systems names must be non-empty");
    }
    const participant = requireRecord(systems[name], `snapshot.systems.${name}`);
    const version = participant.version;
    if (!Number.isInteger(version) || (version as number) <= 0) {
      throw new TypeError(`snapshot.systems.${name}.version must be a positive integer`);
    }
    parsed[name] = {
      version: version as number,
      payload: cloneJsonValue(participant.payload, `snapshot.systems.${name}.payload`)
    };
  }

  return parsed;
}

function parseDynamicRoles(value: unknown): DynamicRole[] {
  if (!Array.isArray(value)) {
    throw new TypeError("snapshot.dynamicRoles must be an array");
  }

  return value.map((entry, index) => {
    const role = requireRecord(entry, `snapshot.dynamicRoles[${index}]`);
    return {
      name: requireString(role.name, `snapshot.dynamicRoles[${index}].name`),
      description: requireString(role.description, `snapshot.dynamicRoles[${index}].description`),
      persona: requireString(role.persona, `snapshot.dynamicRoles[${index}].persona`),
      createdAt: requireString(role.createdAt, `snapshot.dynamicRoles[${index}].createdAt`),
      updatedAt: requireString(role.updatedAt, `snapshot.dynamicRoles[${index}].updatedAt`)
    };
  });
}

function parseTrajectory(value: unknown): TrajectorySnapshot {
  const trajectory = requireRecord(value, "snapshot.trajectory");
  const watermarks = requireRecord(trajectory.watermarks, "snapshot.trajectory.watermarks");
  const parsedWatermarks: Record<string, number> = {};
  for (const character of Object.keys(watermarks).sort()) {
    const watermark = watermarks[character];
    if (!Number.isInteger(watermark) || (watermark as number) < 0) {
      throw new TypeError(`snapshot.trajectory.watermarks.${character} must be a non-negative integer`);
    }
    parsedWatermarks[character] = watermark as number;
  }

  if (!Array.isArray(trajectory.summaries)) {
    throw new TypeError("snapshot.trajectory.summaries must be an array");
  }

  return {
    watermarks: parsedWatermarks,
    summaries: trajectory.summaries.map((entry, index) => parseSummary(entry, index))
  };
}

function parseSummary(value: unknown, index: number): CharacterSummary {
  const path = `snapshot.trajectory.summaries[${index}]`;
  const summary = requireRecord(value, path);
  return {
    character: requireString(summary.character, `${path}.character`),
    summary: requireString(summary.summary, `${path}.summary`),
    coversUpToSeq: requireNonNegativeInteger(summary.coversUpToSeq, `${path}.coversUpToSeq`),
    lastDay: requireInteger(summary.lastDay, `${path}.lastDay`),
    lastHour: requireInteger(summary.lastHour, `${path}.lastHour`),
    updatedAt: requireString(summary.updatedAt, `${path}.updatedAt`)
  };
}

function parseJsonMap(value: unknown, path: string): Record<string, JsonValue> {
  const record = requireRecord(value, path);
  const parsed: Record<string, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    parsed[key] = cloneJsonValue(record[key], `${path}.${key}`);
  }
  return parsed;
}

function cloneJsonValue(value: unknown, path: string): JsonValue {
  try {
    return JSON.parse(canonicalJson(value)) as JsonValue;
  } catch (cause) {
    throw new TypeError(`${path} must be JSON-compatible`, { cause });
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
  return value;
}

function requireInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${path} must be an integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const integer = requireInteger(value, path);
  if (integer < 0) {
    throw new TypeError(`${path} must be non-negative`);
  }
  return integer;
}
