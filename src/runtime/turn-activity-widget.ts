// TUI wiring for the turn-activity panel: installs a widget above the editor
// that animates the current writer stage, streams the prose tail as it is
// generated, and declares memory sedimentation (记忆沉淀) with its own pulsing
// icon. All state transitions and line rendering live in turn-activity.ts;
// this module only owns the pi surfaces (setWidget) and timers.
//
// Lifecycle per pipeline:
//   first event    → install widget (animation timer starts inside the factory)
//   pipeline_done  → memory outcome resolved? linger briefly showing ✓/✗, then
//                    remove the widget. Memory still pending/extracting? keep
//                    the widget pulsing — the OV extraction task runs minutes
//                    past pipeline_done, and its terminal stage_end/stage_error
//                    arrives later through the same sink, which then lingers
//                    and removes. No memory stage at all → remove immediately.
// A new pipeline while the linger is pending cancels the pending removal and
// resets the state in place.
//
// One sink is created per turn, but the extraction watch means a previous
// turn's sink can still be alive when the next turn installs the same widget
// key. Ownership (per ui object) makes the stale sink's removal a no-op so it
// can never tear down its successor's widget; once a sink removes (or loses)
// its widget it is finished and ignores every further event.

import type { ExtensionContextLike, PiComponentLike, PiTuiHostLike } from "../types/pi.ts";
import { createLiveProgressSink, type LiveProgressSink } from "./live-progress.ts";
import {
  applyLiveProgressEvent,
  createTurnActivityState,
  renderTurnActivityLines,
  type TurnActivityState
} from "./turn-activity.ts";

const WIDGET_KEY = "rp-turn-activity";
const FRAME_INTERVAL_MS = 120;
const MEMORY_LINGER_MS = 1500;

/** Which sink currently owns the widget key, per ui surface. */
const widgetOwners = new WeakMap<object, symbol>();

export type TurnActivityWidgetOptions = {
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  lingerMs?: number;
};

/** Post-pipeline memory-watch events continue an existing display instead of
 * starting a new pipeline's. */
function isMemoryContinuationEvent(event: Parameters<LiveProgressSink>[0]): boolean {
  if (event.type === "memory_extracting" || event.type === "memory_unknown") {
    return true;
  }
  return (event.type === "stage_end" || event.type === "stage_error") && event.stage === "openviking";
}

/** Terminal sedimentation outcomes — the widget lingers on these, then clears. */
function isTerminalMemory(memory: string | undefined): boolean {
  return memory === "ok" || memory === "error" || memory === "unknown";
}

export function createTurnActivitySink(
  ctx: ExtensionContextLike,
  options: TurnActivityWidgetOptions = {}
): LiveProgressSink | undefined {
  const ui = ctx.ui;
  if (ui === undefined || typeof ui.setWidget !== "function") {
    return undefined;
  }
  const setWidget = ui.setWidget.bind(ui);
  const setIntervalFn = options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const lingerMs = options.lingerMs ?? MEMORY_LINGER_MS;

  const owner = Symbol("turn-activity-sink");
  const state: TurnActivityState = createTurnActivityState();
  let installed = false;
  let finished = false;
  let activeComponent: (PiComponentLike & { dispose?(): void }) | undefined;
  let pendingClear: unknown;

  const removeWidget = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    finished = true;
    // Only the current owner may clear the shared key — a stale sink whose
    // widget was already replaced by the next turn's must not tear that down.
    if (widgetOwners.get(ui) === owner) {
      widgetOwners.delete(ui);
      try {
        setWidget(WIDGET_KEY, undefined);
      } catch {
        // Widget teardown must never break the turn.
      }
    }
    // pi disposes replaced components, but do not depend on it — the animation
    // timer must stop even if the host skips dispose.
    activeComponent?.dispose?.();
    activeComponent = undefined;
  };

  const installWidget = (): void => {
    if (installed) {
      return;
    }
    installed = true;
    widgetOwners.set(ui, owner);
    try {
      setWidget(WIDGET_KEY, (tui: PiTuiHostLike) => {
        let frame = 0;
        let timer: unknown = setIntervalFn(() => {
          frame += 1;
          try {
            tui.requestRender();
          } catch {
            // Rendering hiccups must not crash the interval callback.
          }
        }, FRAME_INTERVAL_MS);
        const component: PiComponentLike & { dispose(): void } = {
          render(width: number): string[] {
            return renderTurnActivityLines({ state, frame, width });
          },
          invalidate(): void {},
          dispose(): void {
            if (timer !== undefined) {
              clearIntervalFn(timer);
              timer = undefined;
            }
          }
        };
        activeComponent = component;
        return component;
      });
    } catch {
      installed = false;
    }
  };

  const scheduleLingerClear = (): void => {
    pendingClear = setTimeoutFn(() => {
      pendingClear = undefined;
      removeWidget();
    }, lingerMs);
  };

  return (event) => {
    if (finished) {
      return;
    }
    if (pendingClear !== undefined) {
      clearTimeoutFn(pendingClear);
      pendingClear = undefined;
    }

    if (event.type === "pipeline_done") {
      applyLiveProgressEvent(state, event);
      if (isTerminalMemory(state.memory)) {
        // Let the sedimentation outcome linger so the player actually sees it.
        scheduleLingerClear();
      } else if (state.memory === "pending" || state.memory === "extracting") {
        // Extraction still running server-side: keep the widget pulsing until
        // the memory watcher reports the real outcome.
      } else {
        removeWidget();
      }
      return;
    }

    // First event of a new pipeline after a finished one resets in place —
    // unless it is the memory watcher completing the PREVIOUS pipeline's
    // sedimentation, which continues the existing display.
    if (state.phase === "done" && !isMemoryContinuationEvent(event)) {
      Object.assign(state, createTurnActivityState());
    }
    applyLiveProgressEvent(state, event);
    installWidget();
    // Memory outcome arriving after pipeline_done: show it, then clear.
    if (state.phase === "done" && isTerminalMemory(state.memory)) {
      scheduleLingerClear();
    }
  };
}

/** Compose the rich widget sink with the single-line working-message sink. */
export function createTurnProgressSink(
  ctx: ExtensionContextLike,
  options: TurnActivityWidgetOptions = {}
): LiveProgressSink | undefined {
  const widget = createTurnActivitySink(ctx, options);
  const label = createLiveProgressSink(ctx);
  if (widget === undefined) {
    return label;
  }
  if (label === undefined) {
    return widget;
  }
  return async (event) => {
    await widget(event);
    await label(event);
  };
}
