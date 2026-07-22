import { createNewGame } from "../../state/new-game.ts";
import { createInitialState } from "../../state/schema.ts";
import { createSystemRegistry } from "../../systems/registry.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { readRecord, readString, requireStateToolContext } from "./context.ts";

const EMPTY_SYSTEM_REGISTRY = createSystemRegistry([], { capabilities: new Map() });

export const initializeNewGameTool: ToolDefinition<ToolResult> = {
  name: "initialize_new_game",
  label: "RP 状态",
  description:
    "创建并绑定一份新存档，写入玩家身份、起始地点、初始状态和开场情境。仅用于开始新故事或明确重新开局。",
  parameters: {
    type: "object",
    properties: {
      playerName: { type: "string", description: "玩家所扮演角色的姓名。" },
      location: { type: "string", description: "开局时玩家实际所在的地点。" },
      status: { type: "string", description: "开局时玩家需要持续记录的身体、精神或行动状态。" },
      scene: { type: "string", description: "开场时正在发生的核心情境。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsedInput = readRecord(params, "input");
    const toolContext = requireStateToolContext(ctx);
    const defaults = toolContext.initialState;
    const state = createInitialState(
      {
        player: {
          name: readString(parsedInput, "playerName", defaults?.player.name),
          location: readString(parsedInput, "location", defaults?.player.location),
          status: readString(parsedInput, "status", defaults?.player.status)
        },
        time: defaults?.time,
        scene: {
          summary: readString(parsedInput, "scene", defaults?.scene.summary)
        }
      },
      toolContext.attributeSpecs ?? []
    );

    const save = createNewGame({
      db: toolContext.db,
      stateStore: toolContext.stateStore,
      systemRegistry: toolContext.systemRegistry ?? EMPTY_SYSTEM_REGISTRY,
      systemRuntime: toolContext.systemRuntime,
      storySnapshots: toolContext.storySnapshots,
      state,
      piSessionId: toolContext.piSessionId,
      projectRoot: toolContext.projectRoot
    });
    return ok(`New game initialized: ${save.id}`, { saveId: save.id });
  }
};
