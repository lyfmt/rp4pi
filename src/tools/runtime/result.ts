import type { AgentToolResult } from "../../types/pi.ts";

// pi consumes `AgentToolResult`: content is an array of typed parts (never a
// bare string) and details is always present. The pre-fix scaffold returned
// `{ content: string }`, which pi cannot render. Tools build results through
// these helpers so the registry never has to know the wire shape.
export type ToolResult = AgentToolResult<Record<string, unknown>>;

export function ok(content: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: content }], details };
}

export function fail(
  content: string,
  error: Readonly<{ code: string; context: Readonly<Record<string, unknown>> }>
): ToolResult {
  return {
    content: [{ type: "text", text: content }],
    details: { ok: false, error: { code: error.code, context: error.context } }
  };
}

// pi ends the GM agent loop after a tool result carrying `terminate: true`
// instead of feeding the result back to the model for another round. Use this
// for a turn's closing action so the GM stops after handing off.
export function done(content: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: content }], details, terminate: true };
}

/** First text part of a result, for callers/tests that want the model-facing text. */
export function resultText(result: ToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
