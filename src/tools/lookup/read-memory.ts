import { assertUriInCurrentSave, userSpaceForSave } from "../../ov/uri.ts";
import { getActiveSaveIdForMemory, requireOpenVikingToolContext } from "../../ov/search-tools.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";

export const readMemoryTool: ToolDefinition<ToolResult> = {
  name: "read_memory",
  label: "RP 记忆",
  description: "按记忆引用读取当前存档中的一条长期记忆全文。",
  parameters: {
    type: "object",
    required: ["uri"],
    properties: {
      uri: { type: "string", description: "检索结果返回的记忆引用，原样传入。" }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const uri = parseReadInput(params);
    const toolContext = requireOpenVikingToolContext(ctx);
    const saveId = getActiveSaveIdForMemory(toolContext);
    assertUriInCurrentSave(uri, saveId);
    return ok(await toolContext.ovClient.forUser(userSpaceForSave(saveId)).read(uri), { uri });
  }
};

function parseReadInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("read_memory 需要对象 { uri }。");
  }
  const uri = (input as Record<string, unknown>).uri;
  if (typeof uri !== "string" || uri.trim() === "") {
    throw new TypeError("read_memory 需要非空 uri 文本。");
  }
  return uri;
}
