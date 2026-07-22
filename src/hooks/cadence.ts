import type { HookEvery } from "../world/schema.ts";

// The cadence gate: given a hook's optional `every` throttle, the point at which
// it last fired for this save, and the current turn + in-game clock, decide
// whether it fires now. Pure — no db, no clock reads — so the policy is trivially
// testable and the engine stays a thin wiring layer over it.
//
// Semantics (decided upstream):
//   - No `every`            → fire on every anchor hit.
//   - `every` but no prior  → fire (the first hit bootstraps the cadence).
//   - `every` with a prior  → fire when ANY declared unit has elapsed (union),
//                             the permissive default a world can reason about
//                             without knowing evaluation order.
// In-game hours are compared on an absolute timeline (day*24 + hour) so a gate of
// `gameHours: 6` elapses across a day boundary, not just within one day.

/** The moment a hook last fired, as tracked per (save, hook). */
export type HookFirePoint = {
  lastTurn: number;
  lastDay: number;
  lastHour: number;
};

/** The current turn + in-game clock a fire decision is evaluated against. */
export type HookNow = {
  turn: number;
  day: number;
  hour: number;
};

function absoluteHours(day: number, hour: number): number {
  return day * 24 + hour;
}

export function shouldFire(every: HookEvery | undefined, last: HookFirePoint | undefined, now: HookNow): boolean {
  if (every === undefined) {
    return true;
  }
  if (last === undefined) {
    return true;
  }
  if (every.turns !== undefined && now.turn - last.lastTurn >= every.turns) {
    return true;
  }
  if (every.gameDays !== undefined && now.day - last.lastDay >= every.gameDays) {
    return true;
  }
  if (
    every.gameHours !== undefined &&
    absoluteHours(now.day, now.hour) - absoluteHours(last.lastDay, last.lastHour) >= every.gameHours
  ) {
    return true;
  }
  return false;
}
