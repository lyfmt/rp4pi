import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState } from "../../src/state/schema.ts";
import { parseStorySnapshotEnvelope } from "../../src/state/snapshot-envelope.ts";
import { SystemRuntimeError } from "../../src/systems/errors.ts";

function validEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    core: { version: 1, payload: createInitialState() },
    systems: {
      progression: { version: 2, payload: { level: 2, xp: 50, perks: [] } }
    },
    dynamicRoles: [],
    trajectory: { watermarks: {}, summaries: [] },
    capabilities: {}
  };
}

test("parses a complete versioned story snapshot envelope", () => {
  const parsed = parseStorySnapshotEnvelope(validEnvelope());

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.core.version, 1);
  assert.equal(parsed.systems.progression?.version, 2);
  assert.deepEqual(parsed.systems.progression?.payload, { level: 2, xp: 50, perks: [] });
  assert.deepEqual(parsed.dynamicRoles, []);
  assert.deepEqual(parsed.trajectory, { watermarks: {}, summaries: [] });
  assert.deepEqual(parsed.capabilities, {});
});

test("rejects missing and unknown envelope schema versions", () => {
  const missing = validEnvelope();
  delete missing.schemaVersion;

  assertSnapshotIncompatible(() => parseStorySnapshotEnvelope(missing));
  assertSnapshotIncompatible(() => parseStorySnapshotEnvelope({ ...validEnvelope(), schemaVersion: 2 }));
});

test("rejects an invalid core state", () => {
  assertSnapshotIncompatible(() =>
    parseStorySnapshotEnvelope({
      ...validEnvelope(),
      core: { version: 1, payload: { player: null } }
    })
  );
});

test("rejects invalid system versions and non-JSON payloads", () => {
  for (const version of [0, -1, 1.5]) {
    assertSnapshotIncompatible(() =>
      parseStorySnapshotEnvelope({
        ...validEnvelope(),
        systems: { progression: { version, payload: {} } }
      })
    );
  }

  for (const payload of [undefined, Number.NaN, () => undefined]) {
    assertSnapshotIncompatible(() =>
      parseStorySnapshotEnvelope({
        ...validEnvelope(),
        systems: { progression: { version: 1, payload } }
      })
    );
  }

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertSnapshotIncompatible(() =>
    parseStorySnapshotEnvelope({
      ...validEnvelope(),
      systems: { progression: { version: 1, payload: circular } }
    })
  );
});

test("requires every deterministic participant", () => {
  for (const participant of ["dynamicRoles", "trajectory", "capabilities"] as const) {
    const envelope = validEnvelope();
    delete envelope[participant];
    assertSnapshotIncompatible(() => parseStorySnapshotEnvelope(envelope));
  }
});

test("rejects legacy core-only state with a stable error code", () => {
  assertSnapshotIncompatible(() => parseStorySnapshotEnvelope(createInitialState()));
});

function assertSnapshotIncompatible(action: () => unknown): void {
  assert.throws(
    action,
    (error) => error instanceof SystemRuntimeError && error.code === "SNAPSHOT_INCOMPATIBLE"
  );
}
