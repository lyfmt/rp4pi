import type { RpState } from "../state/schema.ts";
import type { HookStateMutation } from "../world/schema.ts";

// Apply a `state` hook's declarative mutations onto an RpState draft, in place.
// Pure over the draft (no db, no clone) so the caller controls persistence via
// stateStore.mutateState. A path addresses either a world attribute
// (`attributes.<name>`) or a fixed-core field; `op: add` is numeric-only and
// `op: set` matches the target's existing primitive type. Invalid paths / type
// mismatches throw with a named message — a mis-declared mutation should fail
// loudly at fire time, not silently corrupt state. `time.hour` wraps into days so
// a per-turn `+1` advances the calendar rather than overflowing past 23.

const FIXED_STRING_PATHS = new Set(["player.name", "player.status", "player.location", "scene.summary"]);

export function applyHookMutations(draft: RpState, mutations: HookStateMutation[]): void {
  for (const mutation of mutations) {
    applyOne(draft, mutation);
  }
}

function applyOne(draft: RpState, mutation: HookStateMutation): void {
  const { path, op, value } = mutation;

  if (path === "time.hour") {
    draft.time = normalizeClock(draft.time.day, numericTarget(draft.time.hour, op, value, path));
    return;
  }
  if (path === "time.day") {
    const day = numericTarget(draft.time.day, op, value, path);
    if (day < 1) {
      throw new RangeError(`Hook mutation "${path}" would set day below 1 (got ${day}).`);
    }
    draft.time = { day, hour: draft.time.hour };
    return;
  }

  if (path.startsWith("attributes.")) {
    const name = path.slice("attributes.".length);
    if (name.length === 0) {
      throw new Error(`Hook mutation path "${path}" is missing an attribute name.`);
    }
    draft.attributes[name] = attributeTarget(draft.attributes[name], op, value, path);
    return;
  }

  if (FIXED_STRING_PATHS.has(path)) {
    if (op === "add") {
      throw new TypeError(`Hook mutation "${path}" is a string field; op must be "set", not "add".`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`Hook mutation "${path}" requires a string value.`);
    }
    assignFixedString(draft, path, value);
    return;
  }

  throw new Error(
    `Hook mutation path "${path}" is not addressable. Use attributes.<name>, time.hour, time.day, player.name, player.status, player.location, or scene.summary.`
  );
}

/** Advance/assign an hour that may exceed [0,23], carrying into days. Days never
 * go below 1 (a mutation that would underflow the calendar is clamped there). */
function normalizeClock(day: number, rawHour: number): { day: number; hour: number } {
  let totalHours = day * 24 + rawHour;
  if (totalHours < 0) {
    totalHours = 0;
  }
  const newDay = Math.floor(totalHours / 24);
  const newHour = totalHours - newDay * 24;
  return { day: Math.max(1, newDay), hour: newHour };
}

function numericTarget(current: number, op: "set" | "add", value: number | string | boolean, path: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`Hook mutation "${path}" requires a numeric value.`);
  }
  return op === "add" ? current + value : value;
}

function attributeTarget(
  current: unknown,
  op: "set" | "add",
  value: number | string | boolean,
  path: string
): number | string | boolean {
  if (op === "add") {
    if (typeof value !== "number") {
      throw new TypeError(`Hook mutation "${path}" op "add" requires a numeric value.`);
    }
    const base = typeof current === "number" ? current : 0;
    return base + value;
  }
  return value;
}

function assignFixedString(draft: RpState, path: string, value: string): void {
  switch (path) {
    case "player.name":
      draft.player.name = value;
      return;
    case "player.status":
      draft.player.status = value;
      return;
    case "player.location":
      draft.player.location = value;
      return;
    case "scene.summary":
      draft.scene.summary = value;
      return;
  }
}
