import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLiveProgressEvent,
  createTurnActivityState,
  MEMORY_ICON_FRAMES,
  renderTurnActivityLines,
  visibleStreamText,
  wrapLine
} from "../../src/runtime/turn-activity.ts";
import { createTurnActivitySink } from "../../src/runtime/turn-activity-widget.ts";
import type { LiveProgressEvent } from "../../src/runtime/live-progress.ts";
import type { ExtensionContextLike, PiComponentLike, PiThemeLike, PiTuiHostLike } from "../../src/types/pi.ts";

function render(state: ReturnType<typeof createTurnActivityState>, frame = 0, width = 80): string[] {
  return renderTurnActivityLines({ state, frame, width });
}

test("idle state renders nothing", () => {
  assert.deepEqual(render(createTurnActivityState()), []);
});

test("draft stage renders animated spinner line with Chinese label", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "draft" });
  const [line] = render(state, 0);
  assert.ok(line !== undefined && line.includes("执笔中"), `line: ${line}`);
  const [nextFrameLine] = render(state, 1);
  assert.notEqual(line, nextFrameLine, "spinner must animate across frames");
});

test("draft stage shows tool lookup name while a tool call is pending", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "draft" });
  applyLiveProgressEvent(state, { type: "tool_call", stage: "draft", id: "t1", name: "read_writing_guide", arguments: {} });
  assert.ok(render(state)[0]?.includes("read_writing_guide"));
  applyLiveProgressEvent(state, { type: "tool_result", stage: "draft", id: "t1", name: "read_writing_guide", result: "ok", isError: false });
  assert.ok(!render(state)[0]?.includes("read_writing_guide"));
});

test("model_delta streams a prose tail preview for prose stages only", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "draft" });
  applyLiveProgressEvent(state, { type: "model_delta", stage: "draft", text: "<thinking>内心盘算</thinking>雨声敲着窗。\n她推门进来。" });
  const lines = render(state);
  assert.ok(lines.some((line) => line.includes("她推门进来")), `lines: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((line) => line.includes("内心盘算")), "thinking must never be previewed");

  // Critic stages do not reset or own the preview: a delta for a critic stage
  // while the preview belongs to draft is ignored.
  applyLiveProgressEvent(state, { type: "stage_start", stage: "inertiaCritic" });
  applyLiveProgressEvent(state, { type: "model_delta", stage: "inertiaCritic", text: "ISSUES 重复意象" });
  const criticLines = render(state);
  assert.ok(!criticLines.some((line) => line.includes("ISSUES")), "critic output is not prose preview");
  assert.ok(criticLines.some((line) => line.includes("她推门进来")), "draft preview stays visible during critics");
});

test("rewrite stage starts a fresh preview", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "draft" });
  applyLiveProgressEvent(state, { type: "model_delta", stage: "draft", text: "旧稿" });
  applyLiveProgressEvent(state, { type: "stage_start", stage: "rewrite" });
  assert.ok(!render(state).some((line) => line.includes("旧稿")));
  applyLiveProgressEvent(state, { type: "model_delta", stage: "rewrite", text: "新稿第一句。" });
  assert.ok(render(state).some((line) => line.includes("新稿第一句")));
});

test("openviking stage renders the dedicated pulsing memory icon", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "openviking", detail: "append_turn" });
  const [line] = render(state, 1);
  assert.ok(line !== undefined && line.includes("记忆沉淀"), `line: ${line}`);
  assert.ok(MEMORY_ICON_FRAMES.some((icon) => line.startsWith(icon)), `line must start with a memory icon frame: ${line}`);
  // Icon pulses across frames.
  const frames = new Set([render(state, 0)[0], render(state, 1)[0], render(state, 2)[0]]);
  assert.ok(frames.size > 1, "memory icon must animate");
});

test("after pipeline_done the memory outcome lingers", () => {
  const state = createTurnActivityState();
  applyLiveProgressEvent(state, { type: "stage_start", stage: "openviking" });
  applyLiveProgressEvent(state, { type: "stage_end", stage: "openviking" });
  applyLiveProgressEvent(state, { type: "pipeline_done" });
  assert.deepEqual(render(state), ["◈ 记忆已沉淀 ✓"]);

  const failed = createTurnActivityState();
  applyLiveProgressEvent(failed, { type: "stage_start", stage: "openviking" });
  applyLiveProgressEvent(failed, { type: "stage_error", stage: "openviking", error: "boom" });
  applyLiveProgressEvent(failed, { type: "pipeline_done" });
  assert.ok(render(failed)[0]?.includes("记忆沉淀失败"));

  const noMemory = createTurnActivityState();
  applyLiveProgressEvent(noMemory, { type: "stage_start", stage: "draft" });
  applyLiveProgressEvent(noMemory, { type: "pipeline_done" });
  assert.deepEqual(render(noMemory), []);
});

test("visibleStreamText sanitizes partial streams", () => {
  assert.equal(visibleStreamText("<thinking>秘密</thinking>正文开头"), "正文开头");
  assert.equal(visibleStreamText("正文开头<thinking>还没写完的思考"), "正文开头");
  assert.equal(visibleStreamText("<content>包裹的正文"), "包裹的正文");
  assert.equal(visibleStreamText("正文<conte"), "正文");
  assert.equal(visibleStreamText("<thinking>只有思考"), "");
});

test("wrapLine wraps CJK text by cell width", () => {
  const wrapped = wrapLine("一二三四五六", 6);
  assert.deepEqual(wrapped, ["一二三", "四五六"]);
  assert.deepEqual(wrapLine("abcdef", 6), ["abcdef"]);
});

type FakeWidget = { content: string[] | ((tui: PiTuiHostLike, theme: PiThemeLike) => PiComponentLike) | undefined };

function fakeCtx(): { ctx: ExtensionContextLike; widgets: Map<string, FakeWidget> } {
  const widgets = new Map<string, FakeWidget>();
  const ctx: ExtensionContextLike = {
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      setWorkingMessage: () => {},
      setWidget: (key, content) => {
        if (content === undefined) {
          widgets.delete(key);
        } else {
          widgets.set(key, { content });
        }
      }
    }
  };
  return { ctx, widgets };
}

function mountWidget(widgets: Map<string, FakeWidget>): PiComponentLike & { dispose?(): void } {
  const widget = [...widgets.values()][0];
  assert.ok(widget !== undefined, "widget must be installed");
  assert.equal(typeof widget.content, "function");
  const factory = widget.content as (tui: PiTuiHostLike, theme: PiThemeLike) => PiComponentLike;
  return factory({ requestRender: () => {} }, { fg: (_c, t) => t, bold: (t) => t });
}

test("widget sink installs on first event, streams, and clears on pipeline_done", async () => {
  const { ctx, widgets } = fakeCtx();
  const timeouts: Array<() => void> = [];
  const intervals: unknown[] = [];
  let cleared = 0;
  const sink = createTurnActivitySink(ctx, {
    setIntervalFn: () => {
      const handle = Symbol("interval");
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: () => {
      cleared += 1;
    },
    setTimeoutFn: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeoutFn: () => {}
  });
  assert.ok(sink !== undefined);

  await sink({ type: "stage_start", stage: "draft" } satisfies LiveProgressEvent);
  assert.equal(widgets.size, 1);
  const component = mountWidget(widgets);
  assert.equal(intervals.length, 1, "animation timer starts when the component mounts");

  await sink({ type: "model_delta", stage: "draft", text: "第一句正文。" });
  assert.ok(component.render(80).some((line) => line.includes("第一句正文")));

  // No memory stage ran → clears immediately on pipeline_done.
  await sink({ type: "pipeline_done" });
  assert.equal(widgets.size, 0, "widget removed without memory linger");
  assert.equal(cleared, 1, "animation timer disposed");
});

test("widget sink lingers after memory sedimentation, then clears", async () => {
  const { ctx, widgets } = fakeCtx();
  const timeouts: Array<() => void> = [];
  const sink = createTurnActivitySink(ctx, {
    setIntervalFn: () => Symbol("interval"),
    clearIntervalFn: () => {},
    setTimeoutFn: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeoutFn: () => {}
  });
  assert.ok(sink !== undefined);

  await sink({ type: "stage_start", stage: "openviking" });
  const component = mountWidget(widgets);
  assert.ok(component.render(80)[0]?.includes("记忆沉淀"));

  await sink({ type: "stage_end", stage: "openviking" });
  await sink({ type: "pipeline_done" });
  assert.equal(widgets.size, 1, "widget lingers to show the sedimentation outcome");
  assert.ok(component.render(80)[0]?.includes("记忆已沉淀"));

  assert.equal(timeouts.length, 1);
  timeouts[0]?.();
  assert.equal(widgets.size, 0, "widget cleared after the linger");
});

test("a new pipeline resets state and cancels a pending linger clear", async () => {
  const { ctx, widgets } = fakeCtx();
  const timeouts: Array<() => void> = [];
  let canceled = 0;
  const sink = createTurnActivitySink(ctx, {
    setIntervalFn: () => Symbol("interval"),
    clearIntervalFn: () => {},
    setTimeoutFn: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeoutFn: () => {
      canceled += 1;
    }
  });
  assert.ok(sink !== undefined);

  await sink({ type: "stage_start", stage: "openviking" });
  await sink({ type: "stage_end", stage: "openviking" });
  await sink({ type: "pipeline_done" });
  assert.equal(widgets.size, 1);

  // Next turn begins before the linger fires: pending removal is canceled and
  // the widget shows the new stage.
  await sink({ type: "stage_start", stage: "draft" });
  assert.equal(canceled, 1, "pending linger clear canceled");
  const component = mountWidget(widgets);
  assert.ok(component.render(80)[0]?.includes("执笔中"));
});

test("sink degrades to undefined without setWidget", () => {
  const ctx: ExtensionContextLike = {
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
      setWorkingMessage: () => {}
    }
  };
  assert.equal(createTurnActivitySink(ctx), undefined);
  assert.equal(createTurnActivitySink({ sessionManager: { getSessionId: () => "s" } }), undefined);
});
