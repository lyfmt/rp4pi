import { formatStatus } from "../../state/status.ts";
import { formatSystemProjections } from "../../systems/status.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { requireStateToolContext } from "./context.ts";

export const getStatusTool: ToolDefinition<ToolResult> = {
  name: "get_status",
  label: "RP 状态",
  description:
    "读取当前存档中已经生效的状态摘要，包括玩家、时间、场景、属性、已成立的事实与关系，以及世界专属规则的当前结果。",
  parameters: {
    type: "object",
    properties: {}
  },
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    const toolContext = requireStateToolContext(ctx);
    const saveId = toolContext.stateStore.getActiveSaveId();
    const projections =
      toolContext.systemRuntime && saveId
        ? await toolContext.systemRuntime.project({
            saveId,
            audience: toolContext.projectionAudience ?? { kind: "gm" }
          })
        : [];
    const sections = [formatStatus(toolContext.stateStore.getState())];
    if (projections.length > 0) {
      sections.push(formatSystemProjections(projections));
    }
    return ok(sections.join("\n\n"), { projections });
  }
};
