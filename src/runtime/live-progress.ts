import type { ExtensionContextLike } from "../types/pi.ts";

// Live progress for the writer pipeline, surfaced through pi's
// `ui.setWorkingMessage`. That API is the *single-line* Loader label pi renders
// at the bottom of the screen while the agent is streaming — it is NOT a
// multiline console. Feeding it a long log (or, worse, the raw `text_delta`
// stream that includes the writer's `<thinking>` content) overflows the status
// area, pushes the chat viewport to the top, and — because pi's `agent_end`
// handler does not reset `workingMessage` — leaks the stale text into the next
// turn's loader. So this module deliberately:
//   1. renders a SINGLE short line (current stage + concise detail),
//   2. ignores per-token `model_text_delta` (prose/thinking belongs only in the
//      committed writer-prose message, never in the working label),
//   3. clears the working message (`setWorkingMessage(undefined)`) on
//      `pipeline_done`, which the turn-hook emits in a finally so a thrown
//      stage still clears it.

export type LiveProgressStage =
  | "draft"
  | "styleEnhancer"
  | "inertiaCritic"
  | "clicheCritic"
  | "rewrite"
  | "commit"
  | "hook"
  | "openviking";

export type LiveProgressEvent =
  | { type: "stage_start"; stage: LiveProgressStage; detail?: string }
  | { type: "stage_end"; stage: LiveProgressStage; output?: string; detail?: string }
  | { type: "stage_error"; stage: LiveProgressStage; error: string }
  | { type: "model_start"; stage: LiveProgressStage; sessionId?: string; model?: string; callIndex?: number }
  | { type: "model_end"; stage: LiveProgressStage; output?: string; toolCallCount?: number; callIndex?: number }
  // Streaming text accumulated so far for the current model call. `text` is the
  // RAW accumulated stream (may contain <thinking>/<content> markup) — display
  // sinks must sanitize before showing (see turn-activity.ts). The single-line
  // working-message sink ignores it entirely.
  | { type: "model_delta"; stage: LiveProgressStage; text: string }
  | { type: "tool_call"; stage: "draft"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; stage: "draft"; id: string; name: string; result: string; isError: boolean }
  | { type: "pipeline_done" };

export type LiveProgressSink = (event: LiveProgressEvent) => void | Promise<void>;

export async function emitLiveProgress(sink: LiveProgressSink | undefined, event: LiveProgressEvent): Promise<void> {
  if (sink === undefined) {
    return;
  }
  try {
    await sink(event);
  } catch {
    // Progress visibility must never break the story turn.
  }
}

export function createLiveProgressSink(ctx: ExtensionContextLike): LiveProgressSink | undefined {
  if (typeof ctx.ui?.setWorkingMessage !== "function") {
    return undefined;
  }

  // `stage_end.output` carries the full rendered prose for draft/revision
  // stages — never put it in the label. Only `detail` (short metadata like
  // `snapshotTurnNo=3` or `append_turn`) is label-safe.
  const render = (event: LiveProgressEvent): string | undefined => {
    switch (event.type) {
      case "stage_start":
        return `writer · ${event.stage}${event.detail ? ` — ${singleLine(event.detail)}` : ""}`;
      case "stage_end":
        return `writer · ${event.stage} ✓${event.detail ? ` — ${singleLine(event.detail)}` : ""}`;
      case "stage_error":
        return `writer · ${event.stage} ✗ ${singleLine(event.error)}`;
      case "tool_call":
        return `writer · draft ▸ ${event.name}`;
      case "pipeline_done":
        return undefined;
      default:
        // model_start / model_end / tool_result are telemetry, not UI.
        return undefined;
    }
  };

  return (event) => {
    const line = render(event);
    // pipeline_done and the ignored events return undefined — only pipeline_done
    // actually clears; others just don't update.
    if (event.type === "pipeline_done") {
      ctx.ui?.setWorkingMessage(undefined);
      return;
    }
    if (line !== undefined) {
      ctx.ui?.setWorkingMessage(line);
    }
  };
}

function singleLine(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}