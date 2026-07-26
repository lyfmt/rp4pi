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

/** 排障提示随错误一起出现：新用户（cp .env.example .env 之外的配置）最常见的
 * 出路是禁用 OV 或修 OPENVIKING_URL，不该让他们从原始 fetch 错误里自己猜。 */
export const OPENVIKING_MEMORY_ERROR_HINT =
  "长期记忆不可用不影响本局继续。暂不需要记忆可在 .env 设 RP_DISABLE_OPENVIKING=1（.env.example 默认如此）；需要则检查 OPENVIKING_URL 与 OpenViking 服务是否可达。";

export function createOpenVikingMemoryErrorMessage(saveId: string, error: unknown): OpenVikingMemoryErrorMessage {
  const message = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    type: "custom",
    source: "openviking-memory-error",
    content: `OpenViking memory append failed: ${message}\n${OPENVIKING_MEMORY_ERROR_HINT}`,
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
