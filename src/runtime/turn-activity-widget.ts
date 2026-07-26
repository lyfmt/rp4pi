// TUI wiring for the turn-activity panel: installs a widget above the editor
// that animates the current writer stage, streams the prose tail as it is
// generated, and declares memory sedimentation (记忆沉淀) with its own pulsing
// icon. All state transitions and line rendering live in turn-activity.ts;
// this module only owns the pi surfaces (setWidget) and timers.
//
// Lifecycle per pipeline:
//   first event    → install widget (animation timer starts inside the factory)
//   pipeline_done  → memory outcome present? linger briefly showing ✓/✗, then
//                    remove the widget; otherwise remove immediately.
// A new pipeline while the linger is pending cancels the pending removal and
// resets the state in place.

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

export type TurnActivityWidgetOptions = {
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  lingerMs?: number;
};

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

  const state: TurnActivityState = createTurnActivityState();
  let installed = false;
  let activeComponent: (PiComponentLike & { dispose?(): void }) | undefined;
  let pendingClear: unknown;

  const removeWidget = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    try {
      setWidget(WIDGET_KEY, undefined);
    } catch {
      // Widget teardown must never break the turn.
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

  return (event) => {
    if (pendingClear !== undefined) {
      clearTimeoutFn(pendingClear);
      pendingClear = undefined;
    }

    if (event.type === "pipeline_done") {
      applyLiveProgressEvent(state, event);
      if (state.memory === "ok" || state.memory === "error") {
        // Let the sedimentation outcome linger so the player actually sees it.
        pendingClear = setTimeoutFn(() => {
          pendingClear = undefined;
          removeWidget();
        }, lingerMs);
      } else {
        removeWidget();
      }
      return;
    }

    // First event of a new pipeline after a finished one: reset in place.
    if (state.phase === "done") {
      Object.assign(state, createTurnActivityState());
    }
    applyLiveProgressEvent(state, event);
    installWidget();
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
