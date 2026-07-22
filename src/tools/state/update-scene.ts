import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, readString, requireStateToolContext } from "./context.ts";

export const updateSceneTool: ToolDefinition<ToolResult> = {
  name: "update_scene",
  label: "RP 状态",
  description: "更新当前场景摘要，用一两句话记录此刻正在发生的核心情境。",
  parameters: {
    type: "object",
    required: ["summary"],
    properties: {
      summary: { type: "string", description: "此刻正在发生的核心情境，用一两句话概括。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const toolContext = requireStateToolContext(ctx);
    const summary = readString(parsedInput, "summary");
    toolContext.stateStore.mutateState((draft) => {
      draft.scene.summary = summary;
    });
    return ok(`Scene updated: ${summary}`);
  }
};
