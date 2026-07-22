import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState } from "../../src/state/schema.ts";
import { applyHookMutations } from "../../src/hooks/state-mutation.ts";

function draft() {
  return createInitialState(
    { player: { name: "阿越", status: "清醒", location: "大厅" }, time: { day: 1, hour: 8 } },
    [{ kind: "int", name: "vigor", initial: 80, min: 0, max: 100 }]
  );
}

test("op add on a world attribute", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "attributes.vigor", op: "add", value: -2 }]);
  assert.equal(s.attributes.vigor, 78);
});

test("op set on a world attribute", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "attributes.vigor", op: "set", value: 50 }]);
  assert.equal(s.attributes.vigor, 50);
});

test("op add on an unseen attribute treats missing as 0", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "attributes.dread", op: "add", value: 3 }]);
  assert.equal(s.attributes.dread, 3);
});

test("time.hour advances and wraps into days", () => {
  const s = draft();
  s.time = { day: 1, hour: 23 };
  applyHookMutations(s, [{ path: "time.hour", op: "add", value: 2 }]);
  assert.deepEqual(s.time, { day: 2, hour: 1 });
});

test("time.hour set is normalized too", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "time.hour", op: "set", value: 30 }]);
  assert.deepEqual(s.time, { day: 2, hour: 6 });
});

test("time.day add", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "time.day", op: "add", value: 1 }]);
  assert.equal(s.time.day, 2);
});

test("fixed string field set", () => {
  const s = draft();
  applyHookMutations(s, [{ path: "player.status", op: "set", value: "疲惫" }]);
  assert.equal(s.player.status, "疲惫");
});

test("add on a string field is rejected", () => {
  assert.throws(() => applyHookMutations(draft(), [{ path: "player.status", op: "add", value: 1 }]), /op must be "set"/);
});

test("unaddressable path is rejected", () => {
  assert.throws(() => applyHookMutations(draft(), [{ path: "player.secret", op: "set", value: "x" }]), /not addressable/);
});

test("multiple mutations apply in order", () => {
  const s = draft();
  applyHookMutations(s, [
    { path: "attributes.vigor", op: "add", value: -5 },
    { path: "time.hour", op: "add", value: 1 }
  ]);
  assert.equal(s.attributes.vigor, 75);
  assert.equal(s.time.hour, 9);
});
