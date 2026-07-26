// Pure state + rendering for the turn-activity widget: the multi-line, animated
// panel shown above the editor while the writer pipeline runs. Split from the
// TUI wiring (turn-activity-widget.ts) so every transition and rendered line is
// unit-testable without pi.
//
// Responsibilities:
//   - fold LiveProgressEvents into a small state machine (stage / phase / tail),
//   - render that state to lines: an animated stage line, plus a streaming
//     prose-tail preview for the stages whose output IS prose (draft /
//     styleEnhancer / rewrite),
//   - give memory sedimentation (openviking stage) its own declared line with a
//     dedicated pulsing icon, so the player can see 记忆沉淀 happening and
//     whether it landed.

import type { LiveProgressEvent, LiveProgressStage } from "./live-progress.ts";
import { extractWriterProse, stripWriterThinking } from "./writer-client.ts";

export type TurnActivityPhase = "idle" | "running" | "done";

export type TurnActivityState = {
  phase: TurnActivityPhase;
  /** Stage currently running (or the last one seen). */
  stage?: LiveProgressStage;
  /** Short label-safe detail for the current stage. */
  detail?: string;
  /** Error text of the most recent stage_error, cleared on the next stage_start. */
  error?: string;
  /** Raw accumulated stream text of the current model call. */
  streamText: string;
  /** Stage the accumulated stream text belongs to. */
  streamStage?: LiveProgressStage;
  /** Name of the writer tool currently being called (draft stage lookups). */
  toolName?: string;
  /**
   * Memory sedimentation lifecycle, kept across pipeline_done: "pending" while
   * the turn is being appended to OV, "extracting" while the server-side
   * extraction task runs (usually minutes, after pipeline_done), then a
   * terminal outcome that lingers briefly before the widget clears — "ok",
   * "error", or "unknown" (the watch gave up without a server verdict).
   */
  memory?: "pending" | "extracting" | "ok" | "error" | "unknown";
  /** Short human-readable outcome detail (e.g. "2 条记忆") for the ✓ display. */
  memoryDetail?: string;
};

export function createTurnActivityState(): TurnActivityState {
  return { phase: "idle", streamText: "" };
}

/** Stages whose streamed output is prose worth previewing live. */
const STREAM_PREVIEW_STAGES: ReadonlySet<LiveProgressStage> = new Set(["draft", "styleEnhancer", "rewrite"]);

const STAGE_LABELS: Record<LiveProgressStage, string> = {
  draft: "执笔中",
  styleEnhancer: "文风增强",
  inertiaCritic: "惯性审稿",
  clicheCritic: "八股审稿",
  rewrite: "修订重写",
  commit: "定稿存档",
  hook: "世界钩子",
  openviking: "记忆沉淀"
};

/** Braille spinner for writer stages. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Dedicated pulsing icon for memory sedimentation (记忆沉淀). */
export const MEMORY_ICON_FRAMES = ["◇", "◈", "◆", "◈"] as const;

export function applyLiveProgressEvent(state: TurnActivityState, event: LiveProgressEvent): void {
  switch (event.type) {
    case "stage_start":
      state.phase = "running";
      state.stage = event.stage;
      state.detail = event.detail;
      state.error = undefined;
      state.toolName = undefined;
      // A new prose-producing stage starts with a fresh preview; critic stages
      // keep the previous preview visible (their own output is not prose).
      if (STREAM_PREVIEW_STAGES.has(event.stage)) {
        state.streamText = "";
        state.streamStage = event.stage;
      }
      if (event.stage === "openviking") {
        state.memory = "pending";
      }
      break;
    case "stage_end":
      state.detail = event.detail ?? state.detail;
      if (event.stage === "openviking") {
        state.memory = "ok";
        state.memoryDetail = event.detail;
      }
      break;
    case "stage_error":
      state.error = event.error;
      if (event.stage === "openviking") {
        state.memory = "error";
      }
      break;
    case "memory_extracting":
      state.memory = "extracting";
      break;
    case "memory_unknown":
      state.memory = "unknown";
      break;
    case "model_delta":
      if (state.streamStage === event.stage) {
        state.streamText = event.text;
      }
      break;
    case "tool_call":
      state.toolName = event.name;
      break;
    case "tool_result":
      state.toolName = undefined;
      break;
    case "pipeline_done":
      state.phase = "done";
      break;
    default:
      break;
  }
}

export type RenderTurnActivityInput = {
  state: TurnActivityState;
  /** Monotonic animation frame counter (the widget timer advances it). */
  frame: number;
  /** Viewport width in terminal cells. */
  width: number;
  /** Max preview lines from the streaming prose tail. */
  maxPreviewLines?: number;
};

const DEFAULT_PREVIEW_LINES = 4;

export function renderTurnActivityLines(input: RenderTurnActivityInput): string[] {
  const { state, frame } = input;
  if (state.phase === "idle") {
    return [];
  }
  const width = Math.max(20, input.width);

  if (state.phase === "done") {
    // Post-pipeline: only memory sedimentation remains interesting; everything
    // else already landed as a committed message. The extraction task runs for
    // minutes after pipeline_done, so the widget keeps pulsing until the real
    // outcome arrives, then lingers on ✓/✗.
    if (state.memory === "pending" || state.memory === "extracting") {
      const icon = MEMORY_ICON_FRAMES[frame % MEMORY_ICON_FRAMES.length] ?? "◈";
      return [truncateToWidth(`${icon} 记忆沉淀 · 正在提取长期记忆…`, width)];
    }
    if (state.memory === "ok") {
      const suffix = state.memoryDetail !== undefined && state.memoryDetail.length > 0 ? `（${state.memoryDetail}）` : "";
      return [truncateToWidth(`◈ 记忆已沉淀 ✓${suffix}`, width)];
    }
    if (state.memory === "error") {
      return [truncateToWidth("◈ 记忆沉淀失败 ✗（正文不受影响）", width)];
    }
    if (state.memory === "unknown") {
      // No server verdict (watch timeout / task API unreachable): the
      // extraction may still land, so declare uncertainty, never a fake ✗.
      return [truncateToWidth("◈ 记忆沉淀状态未知（后台继续，正文不受影响）", width)];
    }
    return [];
  }

  const lines: string[] = [];
  const stage = state.stage;
  if (stage === undefined) {
    return [];
  }

  if (stage === "openviking") {
    const icon = MEMORY_ICON_FRAMES[frame % MEMORY_ICON_FRAMES.length] ?? "◈";
    const action = state.memory === "extracting" ? "正在提取长期记忆…" : "正在写入长期记忆…";
    lines.push(truncateToWidth(`${icon} 记忆沉淀 · ${action}`, width));
  } else {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠿";
    const label = STAGE_LABELS[stage] ?? stage;
    const suffix =
      state.error !== undefined
        ? ` ✗ ${state.error}`
        : state.toolName !== undefined
          ? ` ▸ ${state.toolName}`
          : state.detail !== undefined && state.detail.length > 0
            ? ` — ${state.detail}`
            : "";
    lines.push(truncateToWidth(`${spinner} writer · ${label}${suffix}`, width));
  }

  const preview = streamPreviewLines(state, input.maxPreviewLines ?? DEFAULT_PREVIEW_LINES, width);
  if (preview.length > 0) {
    lines.push(...preview.map((line) => truncateToWidth(`│ ${line}`, width)));
  }
  return lines;
}

function streamPreviewLines(state: TurnActivityState, maxLines: number, width: number): string[] {
  if (state.streamStage === undefined || state.streamText.length === 0) {
    return [];
  }
  const visible = visibleStreamText(state.streamText);
  if (visible.length === 0) {
    return [];
  }
  // Wrap to the viewport, then keep only the tail — the player is watching the
  // newest prose appear, not scrolling history.
  const wrapped = visible
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => wrapLine(line, Math.max(10, width - 4)));
  return wrapped.slice(-maxLines);
}

/**
 * Sanitize a PARTIAL model stream for display: drop closed thinking blocks,
 * cut an unclosed thinking block from its opening tag onward, honor an
 * unclosed <content> wrapper, and hide a trailing half-typed tag.
 */
export function visibleStreamText(raw: string): string {
  let text = raw;
  // Cut everything from an unclosed opening think/thinking/thought tag onward
  // (closed blocks are removed by stripWriterThinking below).
  const unclosed = /<think(?:ing)?\b(?![\s\S]*?<\/think(?:ing)?>)|<thought\b(?![\s\S]*?<\/thought>)/i.exec(text);
  if (unclosed !== null) {
    text = text.slice(0, unclosed.index);
  }
  text = stripWriterThinking(text);
  text = extractWriterProse(text);
  // Hide a trailing partially-streamed tag like "<conte" so it never flashes.
  text = text.replace(/<[a-zA-Z/][^<>]*$/u, "");
  return text.trim();
}

// Terminal-cell width helpers. CJK and fullwidth code points occupy two cells;
// this is an approximation (no grapheme clustering) but errs on the safe side
// for the truncation margin the widget needs.
function charCells(codePoint: number): number {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ? 2
    : 1;
}

export function wrapLine(line: string, maxCells: number): string[] {
  const out: string[] = [];
  let current = "";
  let cells = 0;
  for (const char of line) {
    const w = charCells(char.codePointAt(0) ?? 0);
    if (cells + w > maxCells && current.length > 0) {
      out.push(current);
      current = "";
      cells = 0;
    }
    current += char;
    cells += w;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

function truncateToWidth(line: string, maxCells: number): string {
  let cells = 0;
  let out = "";
  for (const char of line) {
    const w = charCells(char.codePointAt(0) ?? 0);
    if (cells + w > maxCells - 1) {
      return `${out}…`;
    }
    out += char;
    cells += w;
  }
  return out;
}
