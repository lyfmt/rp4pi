import assert from "node:assert/strict";
import test from "node:test";

import { relayBlueprints } from "../../worlds/border-station/systems/relay-blueprints.ts";

test("relay blueprints initializes an empty valid state", () => {
  const state = relayBlueprints.initialize();

  assert.deepEqual(relayBlueprints.parse(state), { blueprints: [] });
});

test("relay blueprints rejects duplicate blueprint ids", () => {
  assert.throws(
    () =>
      relayBlueprints.parse({
        blueprints: [
          { id: "relay-alpha", parts: ["core"], stability: 0.8 },
          { id: "relay-alpha", parts: ["antenna"], stability: 0.7 }
        ]
      }),
    /duplicate blueprint id/
  );
});

test("relay blueprints rejects malformed blueprint state entries", () => {
  const invalidBlueprints = [
    { id: "Relay Alpha", parts: ["core"], stability: 0.8 },
    { id: "relay-alpha", parts: [], stability: 0.8 },
    { id: "relay-alpha", parts: ["core"], stability: Number.NaN },
    { id: "relay-alpha", parts: ["core"], stability: Number.POSITIVE_INFINITY },
    { id: "relay-alpha", parts: ["core"], stability: -0.01 },
    { id: "relay-alpha", parts: ["core"], stability: 1.01 }
  ];

  for (const blueprint of invalidBlueprints) {
    assert.throws(() => relayBlueprints.parse({ blueprints: [blueprint] }));
  }
});

test("relay blueprints creates a blueprint through its command interface", () => {
  const create = relayBlueprints.commands.create;
  assert.ok(create);
  const state = relayBlueprints.parse({ blueprints: [] });
  const input = create.parseInput({
    id: "relay-alpha",
    parts: ["core", "antenna"],
    stability: 0.82
  });

  const outcome = create.execute(
    {
      read: () => {
        throw new Error("create must not read another system");
      },
      capability: () => {
        throw new Error("create must not use a capability");
      }
    },
    state,
    input
  );

  assert.deepEqual(outcome, {
    nextState: {
      blueprints: [
        { id: "relay-alpha", parts: ["core", "antenna"], stability: 0.82 }
      ]
    },
    result: { id: "relay-alpha", accepted: true }
  });
});

test("relay blueprints rejects malformed create input before execution", () => {
  const create = relayBlueprints.commands.create;
  assert.ok(create);

  const invalidInputs = [
    { id: "relay-alpha", parts: ["core"] },
    { id: "relay-alpha", parts: [], stability: 0.8 },
    { id: "relay-alpha", parts: ["core"], stability: -0.1 },
    { id: "relay-alpha", parts: ["core"], stability: 1.1 }
  ];
  for (const input of invalidInputs) {
    assert.throws(() => create.parseInput(input));
  }
});

test("relay blueprints refuses to create a duplicate id", () => {
  const create = relayBlueprints.commands.create;
  assert.ok(create);
  const state = relayBlueprints.parse({
    blueprints: [{ id: "relay-alpha", parts: ["core"], stability: 0.8 }]
  });
  const input = create.parseInput({
    id: "relay-alpha",
    parts: ["antenna"],
    stability: 0.7
  });

  assert.throws(
    () =>
      create.execute(
        { read: () => undefined, capability: () => undefined },
        state,
        input
      ),
    /duplicate blueprint id/
  );
});

test("relay blueprints projects a detached read model without raw parts", () => {
  const state = relayBlueprints.parse({
    blueprints: [
      { id: "relay-alpha", parts: ["core", "antenna"], stability: 0.82 }
    ]
  });

  const projection = relayBlueprints.project(
    { audience: { kind: "gm" } },
    state
  ) as {
    count: number;
    blueprints: Array<{ id: string; partCount: number; stability: number }>;
  };

  assert.deepEqual(projection, {
    count: 1,
    blueprints: [{ id: "relay-alpha", partCount: 2, stability: 0.82 }]
  });
  projection.blueprints[0]!.stability = 0;
  assert.equal(state.blueprints[0]!.stability, 0.82);
});
