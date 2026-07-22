import { memoryRootForSave } from "../../ov/uri.ts";
import { userSpaceForSave } from "../../ov/uri.ts";
import { getActiveSaveIdForMemory, requireOpenVikingToolContext } from "../../ov/search-tools.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";

export const searchMemoryTool: ToolDefinition<ToolResult> = {
  name: "search_memory",
  label: "RP 记忆",
  description: "在当前存档的长期记忆中检索早先已经发生的人物经历、事件、承诺和线索。",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "要回想的人物、事件、承诺或线索。" },
      limit: { type: "integer", description: "返回条数上限，默认 5。" }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsed = parseSearchInput(params);
    const toolContext = requireOpenVikingToolContext(ctx);
    const saveId = getActiveSaveIdForMemory(toolContext);
    const results = await toolContext.ovClient
      .forUser(userSpaceForSave(saveId))
      .find(parsed.query, memoryRootForSave(saveId), parsed.limit);
    const content = results.map((result) => `${result.uri}\n${result.abstract}\nscore: ${result.score}`).join("\n\n");
    return ok(content, { results });
  }
};

function parseSearchInput(input: unknown): { query: string; limit: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("search_memory 需要对象 { query, limit? }。");
  }
  const record = input as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new TypeError("search_memory 需要非空 query 文本。");
  }
  return { query, limit: normalizeLimit(record.limit) };
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return 5;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5;
}
