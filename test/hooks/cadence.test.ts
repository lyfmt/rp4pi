import assert from "node:assert/strict";
import test from "node:test";

import { shouldFire } from "../../src/hooks/cadence.ts";

const now = { turn: 10, day: 3, hour: 12 };

test("no every gate always fires", () => {
  assert.equal(shouldFire(undefined, undefined, now), true);
  assert.equal(shouldFire(undefined, { lastTurn: 10, lastDay: 3, lastHour: 12 }, now), true);
});

test("first fire (no prior) fires even with a gate", () => {
  assert.equal(shouldFire({ turns: 5 }, undefined, now), true);
});

test("turns gate: fires only after enough turns elapse", () => {
  assert.equal(shouldFire({ turns: 3 }, { lastTurn: 8, lastDay: 3, lastHour: 12 }, now), false);
  assert.equal(shouldFire({ turns: 3 }, { lastTurn: 7, lastDay: 3, lastHour: 12 }, now), true);
});

test("gameHours gate spans day boundaries on an absolute timeline", () => {
  // last at day 2 hour 20, now day 3 hour 12 → 16 hours elapsed.
  assert.equal(shouldFire({ gameHours: 6 }, { lastTurn: 0, lastDay: 2, lastHour: 20 }, now), true);
  assert.equal(shouldFire({ gameHours: 20 }, { lastTurn: 0, lastDay: 2, lastHour: 20 }, now), false);
});

test("gameDays gate", () => {
  assert.equal(shouldFire({ gameDays: 2 }, { lastTurn: 0, lastDay: 1, lastHour: 0 }, now), true);
  assert.equal(shouldFire({ gameDays: 3 }, { lastTurn: 0, lastDay: 1, lastHour: 0 }, now), false);
});

test("multiple units fire when ANY has elapsed (union)", () => {
  const last = { lastTurn: 9, lastDay: 1, lastHour: 12 };
  // turns not elapsed (1 < 3) but gameDays elapsed (2 >= 2).
  assert.equal(shouldFire({ turns: 3, gameDays: 2 }, last, now), true);
});
