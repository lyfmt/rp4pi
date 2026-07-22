import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readInteger, readRecord, requireStateToolContext } from "./context.ts";

export const updateTimeTool: ToolDefinition<ToolResult> = {
  name: "update_time",
  label: "RP 状态",
  description: "设定明确的故事时刻，或按经过的小时数推进故事时间。",
  parameters: {
    type: "object",
    properties: {
      absolute: {
        type: "object",
        description: "要设定的明确故事时刻，包含 day 和 hour。",
        properties: {
          day: { type: "integer", description: "故事中的天数。" },
          hour: { type: "integer", description: "当天的小时数。" }
        }
      },
      advanceHours: { type: "integer", description: "故事中实际经过的小时数。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const hasAbsolute = parsedInput.absolute !== undefined && parsedInput.absolute !== null;
    const hasRelative = parsedInput.advanceHours !== undefined && parsedInput.advanceHours !== null;
    if (hasAbsolute === hasRelative) {
      throw new Error("时间工具需要恰好一种模式：absolute={day,hour} 或 advanceHours。");
    }

    const toolContext = requireStateToolContext(ctx);
    toolContext.stateStore.mutateState((draft) => {
      if (hasAbsolute) {
        const absolute = readRecord(parsedInput.absolute, "absolute");
        draft.time.day = readInteger(absolute, "day");
        draft.time.hour = readInteger(absolute, "hour");
        return;
      }

      const totalHours = draft.time.day * 24 + draft.time.hour + readInteger(parsedInput, "advanceHours");
      draft.time.day = Math.floor(totalHours / 24);
      draft.time.hour = totalHours % 24;
    });

    const state = toolContext.stateStore.getState();
    return ok(`Time updated: Day ${state.time.day}, ${state.time.hour.toString().padStart(2, "0")}:00`);
  }
};
