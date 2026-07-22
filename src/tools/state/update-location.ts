import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, readString, requireStateToolContext } from "./context.ts";

export const updateLocationTool: ToolDefinition<ToolResult> = {
  name: "update_location",
  label: "RP 状态",
  description: "将玩家当前地点更新为叙事中已经实际抵达的地点。",
  parameters: {
    type: "object",
    required: ["location"],
    properties: {
      location: { type: "string", description: "叙事中已经实际抵达的地点。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const toolContext = requireStateToolContext(ctx);
    const location = readString(parsedInput, "location");
    toolContext.stateStore.mutateState((draft) => {
      draft.player.location = location;
    });
    return ok(`Location updated: ${location}`);
  }
};
