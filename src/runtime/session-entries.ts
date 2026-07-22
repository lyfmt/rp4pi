import { PROSE_CUSTOM_TYPE } from "./prose-message.ts";
import type { WriterHistoryItem } from "./writer-history.ts";

// Bridges pi `SessionEntry[]` (from ctx.sessionManager.getEntries()) into the
// domain inputs `commitTurn` needs: the latest player message and the prior
// writer-prose history. Kept as pure functions over a *structural* subset of
// the session entry shape so the runtime stays testable without pi.

type TextLike = { type?: string; text?: unknown };

type MessageLike = {
  role?: string;
  content?: unknown;
};

type SessionEntryLike =
  | { type: "message"; message?: MessageLike }
  | { type: "custom_message"; customType?: string; content?: unknown; details?: unknown }
  | { type?: string; [key: string]: unknown };

type ToolResultMessageLike = MessageLike & {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  details?: { packet?: unknown } | unknown;
};

/** A submitted-but-not-yet-rendered direction packet, identified by its tool call. */
export type PendingDirectionPacket = {
  packet: unknown;
  toolCallId: string;
};

// Walks the session backwards looking for the most recent submit_direction_packet
// tool result. Stops at the first writer-prose custom message: once prose for a
// turn is persisted, that turn's packet is no longer pending. This is the
// "render on agent_end" seam — Pass A (the GM loop) has ended and left its packet
// in the transcript; we find it here instead of reacting to a mid-loop tool_result
// event, which would deliver prose before the agent is idle and re-trigger the loop.
export function findPendingDirectionPacket(entries: readonly unknown[]): PendingDirectionPacket | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as SessionEntryLike;
    if (entry?.type === "custom_message" && (entry as { customType?: string }).customType === PROSE_CUSTOM_TYPE) {
      return undefined;
    }
    if (entry?.type !== "message") {
      continue;
    }
    const message = (entry as { message?: ToolResultMessageLike }).message;
    if (message?.role !== "toolResult" || message.toolName !== "submit_direction_packet") {
      continue;
    }
    const packet = readPacketDetails(message.details);
    if (packet === undefined || typeof message.toolCallId !== "string") {
      continue;
    }
    return { packet, toolCallId: message.toolCallId };
  }
  return undefined;
}

function readPacketDetails(details: unknown): unknown {
  if (!isRecord(details)) {
    return undefined;
  }
  return (details as { packet?: unknown }).packet;
}

/** Latest user message text in the session, or undefined if none. */
export function latestPlayerInput(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as SessionEntryLike;
    if (entry?.type !== "message") {
      continue;
    }
    const message = (entry as { message?: MessageLike }).message;
    if (message?.role !== "user") {
      continue;
    }
    const text = extractText(message.content);
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

/** Prior writer-prose entries, oldest first, as writer history items. */
export function writerHistoryFromEntries(entries: readonly unknown[]): WriterHistoryItem[] {
  const history: WriterHistoryItem[] = [];
  for (const raw of entries) {
    const entry = raw as SessionEntryLike;
    if (entry?.type !== "custom_message" || (entry as { customType?: string }).customType !== PROSE_CUSTOM_TYPE) {
      continue;
    }
    const content = extractText((entry as { content?: unknown }).content);
    if (content.length > 0) {
      history.push({ kind: "custom-prose", content });
    }
  }
  return history;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is TextLike => isRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
