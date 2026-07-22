import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintBatch } from "../../src/systems/canonical-json.ts";

test("fingerprint ignores object key order but preserves operation order", () => {
  const first = { system: "x", command: "set", input: { a: 1, b: 2 } };
  const reordered = { system: "x", command: "set", input: { b: 2, a: 1 } };
  const second = { system: "y", command: "append", input: { value: "next" } };

  assert.equal(fingerprintBatch([first]), fingerprintBatch([reordered]));
  assert.notEqual(fingerprintBatch([first, second]), fingerprintBatch([second, first]));
  assert.match(fingerprintBatch([first]), /^[0-9a-f]{64}$/);
});

test("fingerprint rejects values outside canonical JSON", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const invalidValues: unknown[] = [
    undefined,
    () => undefined,
    Symbol("invalid"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    circular
  ];

  for (const input of invalidValues) {
    assert.throws(() => {
      fingerprintBatch([{ system: "x", command: "set", input }]);
    });
  }
});
