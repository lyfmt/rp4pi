import type { ExtensionContextLike } from "../types/pi.ts";
import type { LiveProgressSink } from "./live-progress.ts";

// In-process pub/sub that bridges the two-pass-render extension (which produces
// a turn's prose on agent_end) to any other extension that needs that prose —
// without a direct import between them. OpenViking long-term memory subscribes
// here instead of listening on agent_end itself, because the rendered prose
// only exists in memory during that single handler invocation; there is no
// other seam to hand it across an extension boundary. Listeners are awaited in
// registration order so the producer can guarantee delivery ordering (prose is
// delivered first, then any memory-error notice a listener emits).
export type TurnRenderedEvent = {
  ctx: ExtensionContextLike;
  saveId: string;
  playerInput: string | undefined;
  prose: string;
  progress?: LiveProgressSink;
};

export type TurnRenderedListener = (event: TurnRenderedEvent) => void | Promise<void>;

type TurnEventRegistry = {
  listeners: Set<TurnRenderedListener>;
};

type TurnEventGlobal = typeof globalThis & {
  [key: symbol]: TurnEventRegistry | undefined;
};

const TURN_EVENTS_KEY = Symbol.for("my-rp-agent.turn-events");

function registry(): TurnEventRegistry {
  const root = globalThis as TurnEventGlobal;
  const existing = root[TURN_EVENTS_KEY];
  if (existing) {
    return existing;
  }
  const created = { listeners: new Set<TurnRenderedListener>() };
  root[TURN_EVENTS_KEY] = created;
  return created;
}

/** Subscribe to turn-rendered events. Returns an unsubscribe function. */
export function onTurnRendered(listener: TurnRenderedListener): () => void {
  registry().listeners.add(listener);
  return () => {
    registry().listeners.delete(listener);
  };
}

export async function emitTurnRendered(event: TurnRenderedEvent): Promise<void> {
  for (const listener of registry().listeners) {
    await listener(event);
  }
}

/** Drop all listeners — used by tests to isolate per-case subscriptions. */
export function resetTurnListenersForTest(): void {
  registry().listeners.clear();
}
