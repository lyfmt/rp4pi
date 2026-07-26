import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { LiveProgressEvent } from "../../src/runtime/live-progress.ts";
import type { OpenVikingClient, OpenVikingTaskStatus } from "../../src/ov/client.ts";

const watchModule = await import(
  pathToFileURL(new URL("../../src/ov/extraction-watch.ts", import.meta.url).pathname).href
);
const watchMemoryExtraction =
  watchModule.watchMemoryExtraction as typeof import("../../src/ov/extraction-watch.js").watchMemoryExtraction;

// Only getTask matters to the watcher; everything else throws if touched.
function taskClient(responses: Array<OpenVikingTaskStatus | Error>): OpenVikingClient {
  let call = 0;
  const unusedError = () => new Error("watcher must only call getTask");
  return {
    forUser() {
      throw unusedError();
    },
    async ensureSession() {
      throw unusedError();
    },
    async addSessionMessage() {
      throw unusedError();
    },
    async commitSession() {
      throw unusedError();
    },
    async getTask() {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (response instanceof Error) {
        throw response;
      }
      return response ?? {};
    },
    async find() {
      throw unusedError();
    },
    async read() {
      throw unusedError();
    }
  };
}

// Fires scheduled callbacks on the next microtask so the poll loop advances
// deterministically without real timers.
const immediateTimeout = (callback: () => void, _ms: number): unknown => {
  queueMicrotask(callback);
  return Symbol("timer");
};

function collectEvents(): { events: LiveProgressEvent[]; progress: (event: LiveProgressEvent) => void } {
  const events: LiveProgressEvent[] = [];
  return { events, progress: (event) => events.push(event) };
}

test("watch emits stage_end with the memory count when the task completes", async () => {
  const { events, progress } = collectEvents();
  const handle = watchMemoryExtraction({
    client: taskClient([{ status: "running" }, { status: "completed", memoriesExtracted: 2 }]),
    taskId: "task-1",
    progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {}
  });
  await handle.done;
  assert.deepEqual(events, [{ type: "stage_end", stage: "openviking", detail: "2 条记忆" }]);
});

test("watch omits the count detail when the completed task reports none", async () => {
  const { events, progress } = collectEvents();
  const handle = watchMemoryExtraction({
    client: taskClient([{ status: "completed", memoriesExtracted: 0 }]),
    taskId: "task-1",
    progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {}
  });
  await handle.done;
  assert.deepEqual(events, [{ type: "stage_end", stage: "openviking", detail: undefined }]);
});

test("watch emits stage_error when the task fails", async () => {
  const { events, progress } = collectEvents();
  const handle = watchMemoryExtraction({
    client: taskClient([{ status: "failed", error: "extraction blew up" }]),
    taskId: "task-1",
    progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {}
  });
  await handle.done;
  assert.deepEqual(events, [{ type: "stage_error", stage: "openviking", error: "extraction blew up" }]);
});

test("watch tolerates transient poll failures but gives up after three in a row", async () => {
  const boom = new Error("connection refused");
  const tolerated = collectEvents();
  const toleratedHandle = watchMemoryExtraction({
    client: taskClient([boom, boom, { status: "completed", memoriesExtracted: 1 }]),
    taskId: "task-1",
    progress: tolerated.progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {}
  });
  await toleratedHandle.done;
  assert.deepEqual(tolerated.events, [{ type: "stage_end", stage: "openviking", detail: "1 条记忆" }]);

  const givesUp = collectEvents();
  const givesUpHandle = watchMemoryExtraction({
    client: taskClient([boom]),
    taskId: "task-1",
    progress: givesUp.progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {}
  });
  await givesUpHandle.done;
  // No server verdict — the outcome is unknown, never a definitive failure.
  assert.equal(givesUp.events.length, 1);
  assert.equal(givesUp.events[0]?.type, "memory_unknown");
  assert.match((givesUp.events[0] as { reason: string }).reason, /connection refused/);
});

test("watch reports an unknown outcome when the budget is exhausted", async () => {
  const { events, progress } = collectEvents();
  let now = 0;
  const handle = watchMemoryExtraction({
    client: taskClient([{ status: "running" }]),
    taskId: "task-1",
    progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 10,
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: () => {},
    nowFn: () => {
      now += 6;
      return now;
    }
  });
  await handle.done;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "memory_unknown");
  assert.match((events[0] as { reason: string }).reason, /超时/);
});

test("a canceled watch emits nothing and settles", async () => {
  const { events, progress } = collectEvents();
  const pending: Array<() => void> = [];
  const handle = watchMemoryExtraction({
    client: taskClient([{ status: "running" }]),
    taskId: "task-1",
    progress,
    pollIntervalMs: 1,
    watchTimeoutMs: 60_000,
    setTimeoutFn: (callback) => {
      pending.push(callback);
      return pending.length;
    },
    clearTimeoutFn: () => {}
  });
  handle.cancel();
  await handle.done;
  assert.deepEqual(events, []);
});
