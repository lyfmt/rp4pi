import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, readString, requireStateToolContext } from "./context.ts";

export const updatePlayerStatusTool: ToolDefinition<ToolResult> = {
  name: "update_player_status",
  label: "RP 状态",
  description: "更新玩家当前需要持续记录的身体、精神或行动状态。",
  parameters: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", description: "玩家当前需要持续记录的身体、精神或行动状态。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const toolContext = requireStateToolContext(ctx);
    const status = readString(parsedInput, "status");
    toolContext.stateStore.mutateState((draft) => {
      draft.player.status = status;
    });
    return ok(`Player status updated: ${status}`);
  }
};
