/** pi `customType` used for writer-rendered prose entries in the session. */
export const PROSE_CUSTOM_TYPE = "writer-prose";

export type RuntimeMessage = {
  role: string;
  content?: string;
  type?: string;
  source?: string;
  data?: Record<string, unknown>;
};

export type WriterProseMessage = RuntimeMessage & {
  role: "assistant";
  type: "custom";
  source: "writer-prose";
  content: string;
  data: {
    prose: string;
  };
};

export type OpenVikingMemoryErrorMessage = RuntimeMessage & {
  role: "assistant";
  type: "custom";
  source: "openviking-memory-error";
  content: string;
  data: {
    saveId: string;
    error: string;
  };
};

export function createWriterProseMessage(prose: string): WriterProseMessage {
  return {
    role: "assistant",
    type: "custom",
    source: "writer-prose",
    content: prose,
    data: { prose }
  };
}

export type HookNoticeMessage = RuntimeMessage & {
  role: "assistant";
  type: "custom";
  source: "hook-notice";
  content: string;
  data: {
    hook: string;
  };
};

/** A player-facing notice emitted by a world hook (inject/as:notice). Delivered
 * idle like any other injected message so it does not re-trigger the GM loop. */
export function createHookNoticeMessage(hook: string, text: string): HookNoticeMessage {
  return {
    role: "assistant",
    type: "custom",
    source: "hook-notice",
    content: text,
    data: { hook }
  };
}

export function createOpenVikingMemoryErrorMessage(saveId: string, error: unknown): OpenVikingMemoryErrorMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    type: "custom",
    source: "openviking-memory-error",
    content: `OpenViking memory append failed: ${message}`,
    data: { saveId, error: message }
  };
}

export function isWriterProseMessage(message: unknown): message is WriterProseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as RuntimeMessage).role === "assistant" &&
    (message as RuntimeMessage).type === "custom" &&
    (message as RuntimeMessage).source === "writer-prose" &&
    typeof (message as RuntimeMessage).content === "string"
  );
}
