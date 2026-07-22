import { readHookFireState, recordHookFire } from "../state/hook-fire-state.ts";
import { latestStorySnapshotTurnNo } from "../state/snapshots.ts";
import { readLatestState } from "../state/sqlite.ts";
import type { RpDatabase } from "../state/sqlite.ts";
import type { StateStore } from "../state/store.ts";
import type { HookAnchor, HookSpec } from "../world/schema.ts";
import { shouldFire, type HookNow } from "./cadence.ts";
import { applyHookMutations } from "./state-mutation.ts";

// The hook engine: at a lifecycle anchor, run every world hook bound to it whose
// cadence gate has elapsed, dispatch its action, and record the fire so the
// per-save cadence advances. This is the base-platform machinery the world only
// declares against (mirroring the subagents materializer).
//
// Effect delivery (getting a prompt in front of the GM, a notice in front of the
// player) is INJECTED via `HookDelivery` so the engine stays pure over its inputs
// and unit-testable with a fake; the extension wiring (core.ts) supplies the real
// pi-backed delivery. State mutations are applied through the shared stateStore so
// they persist exactly like a tool write.
//
// Turn counting: `latestStorySnapshotTurnNo` is the number of committed turns, the
// stable counter a `turns:` cadence measures. At `turn_committed` it already
// reflects the just-committed turn; at `turn_start` / `session_start` it is the
// last committed turn. Using one counter everywhere keeps cadence math simple and
// roll-safe (a `/roll` lowers the count, but fire-state is intentionally not
// rolled back — see hook-fire-state.ts).

export type HookDelivery = {
  /** Guidance fed to the GM for the turn it is about to (or will next) run. */
  prompt(text: string): void;
  /** A player-facing styled notice, delivered when the agent is idle. */
  notice(text: string): void;
};

export type HookEngineDeps = {
  db: RpDatabase;
  stateStore: StateStore;
  delivery: HookDelivery;
  /** Optional progress log (e.g. console in dev, no-op in tests). */
  log?: (message: string) => void;
};

/** A record of one hook that fired, for logging and test assertions. */
export type FiredHook = {
  name: string;
  anchor: HookAnchor;
  action: HookSpec["action"]["type"];
};

/**
 * Fire every hook of `world.hooks` bound to `anchor` whose cadence has elapsed,
 * in declaration order. Returns the hooks that fired. No-op (returns []) when the
 * world declares no hooks for this anchor.
 */
export function fireHooks(input: {
  hooks: readonly HookSpec[];
  anchor: HookAnchor;
  saveId: string;
  deps: HookEngineDeps;
}): FiredHook[] {
  const { hooks, anchor, saveId, deps } = input;
  const bound = hooks.filter((hook) => hook.on === anchor);
  if (bound.length === 0) {
    return [];
  }

  const now = currentPoint(deps.db, saveId);
  const fired: FiredHook[] = [];

  for (const hook of bound) {
    const last = readHookFireState(deps.db, saveId, hook.name);
    if (!shouldFire(hook.every, last, now)) {
      continue;
    }
    try {
      dispatch(hook, deps);
    } catch (error) {
      // A hook must never break the turn it rides on. Surface the failure to the
      // log and move on; the story commit / turn is authoritative, hooks are
      // best-effort embellishment.
      deps.log?.(`hook "${hook.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    recordHookFire(deps.db, saveId, hook.name, now);
    fired.push({ name: hook.name, anchor, action: hook.action.type });
  }

  return fired;
}

function dispatch(hook: HookSpec, deps: HookEngineDeps): void {
  const action = hook.action;
  switch (action.type) {
    case "inject":
      if (action.as === "notice") {
        deps.delivery.notice(action.text);
      } else {
        deps.delivery.prompt(action.text);
      }
      return;
    case "state":
      deps.stateStore.mutateState((draft) => applyHookMutations(draft, action.mutations));
      return;
    case "delegate":
      // A hook runs outside the GM loop and cannot call the `subagent` tool
      // itself, so a delegate materializes as an instruction the GM acts on in
      // its turn. Autonomous out-of-loop spawning is a later axis.
      deps.delivery.prompt(
        `〔系统提示〕请委派子代理「${action.subagent}」完成以下任务，并把结果自然织入本回合叙事：${action.task}`
      );
      return;
  }
}

function currentPoint(db: RpDatabase, saveId: string): HookNow {
  const turn = latestStorySnapshotTurnNo(db, saveId);
  const state = readLatestState(db, saveId);
  return { turn, day: state?.time.day ?? 1, hour: state?.time.hour ?? 8 };
}
