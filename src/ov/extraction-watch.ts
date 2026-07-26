import { emitLiveProgress, type LiveProgressSink } from "../runtime/live-progress.ts";
import type { OpenVikingClient } from "./client.ts";
import { readOpenVikingTimeouts } from "./config.ts";

// OV's commit endpoint only ENQUEUES memory extraction and returns a task_id;
// the extraction itself is a server-side LLM task that routinely runs for
// minutes. This watcher follows that task and reports the REAL sedimentation
// outcome to the live-progress sink (the turn-activity widget keeps pulsing
// until it hears one of these terminal events).
//
// The watch is deliberately DETACHED from the tracked story-commit chain: the
// append/commit itself is drained on shutdown and next-turn input, but nobody
// may block a quit or a follow-up turn on minutes of extraction. Callers hold
// the returned handle and cancel() it on shutdown or when a newer turn takes
// over the widget; a canceled watch emits nothing.

export type WatchMemoryExtractionInput = {
  client: OpenVikingClient;
  taskId: string;
  progress: LiveProgressSink;
  pollIntervalMs?: number;
  watchTimeoutMs?: number;
  /** Injectable clocks for tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  nowFn?: () => number;
};

export type ExtractionWatchHandle = {
  /** Settles when the watch ends (terminal event emitted or canceled). Never rejects. */
  done: Promise<void>;
  cancel(): void;
};

/** Consecutive poll failures tolerated before the watch gives up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export function watchMemoryExtraction(input: WatchMemoryExtractionInput): ExtractionWatchHandle {
  const timeouts = readOpenVikingTimeouts();
  const pollIntervalMs = input.pollIntervalMs ?? timeouts.extractPollIntervalMs;
  const watchTimeoutMs = input.watchTimeoutMs ?? timeouts.extractWatchTimeoutMs;
  const setTimeoutFn = input.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn = input.clearTimeoutFn ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const nowFn = input.nowFn ?? (() => Date.now());

  let canceled = false;
  let pendingTimer: unknown;
  let wake: (() => void) | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      pendingTimer = setTimeoutFn(() => {
        pendingTimer = undefined;
        resolve();
      }, ms);
    });

  const cancel = (): void => {
    canceled = true;
    if (pendingTimer !== undefined) {
      clearTimeoutFn(pendingTimer);
      pendingTimer = undefined;
    }
    wake?.();
  };

  const done = (async () => {
    const deadline = nowFn() + watchTimeoutMs;
    let consecutiveFailures = 0;
    while (!canceled) {
      await sleep(pollIntervalMs);
      if (canceled) {
        return;
      }
      let task;
      try {
        task = await input.client.getTask(input.taskId);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          // The task API stopped answering — that is NOT a verdict on the
          // extraction itself, which may still land. Report unknown, never ✗.
          if (!canceled) {
            await emitLiveProgress(input.progress, {
              type: "memory_unknown",
              reason: `任务状态查询失败: ${error instanceof Error ? error.message : String(error)}`
            });
          }
          return;
        }
        continue;
      }
      if (canceled) {
        return;
      }
      if (task.status === "completed") {
        const count = task.memoriesExtracted;
        await emitLiveProgress(input.progress, {
          type: "stage_end",
          stage: "openviking",
          detail: count !== undefined && count > 0 ? `${count} 条记忆` : undefined
        });
        return;
      }
      if (task.status === "failed") {
        await emitLiveProgress(input.progress, {
          type: "stage_error",
          stage: "openviking",
          error: task.error ?? "memory extraction failed"
        });
        return;
      }
      if (nowFn() >= deadline) {
        // Watch budget exhausted without a verdict — the task may still be
        // running server-side. Unknown, not failed.
        await emitLiveProgress(input.progress, {
          type: "memory_unknown",
          reason: "记忆提取超时（任务可能仍在后台运行）"
        });
        return;
      }
    }
  })();

  return { done, cancel };
}
