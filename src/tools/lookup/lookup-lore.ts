import { formatLoreLookupResults, searchLore } from "../../lore/search.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { requireStateToolContext } from "../state/context.ts";

export const lookupLoreTool: ToolDefinition<ToolResult> = {
  name: "lookup",
  label: "RP 资料",
  description: "查询当前世界已经确定且不随本局经历改变的人物、地点、背景与规则设定。",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "要查证的世界设定关键词或问题。" },
      kind: { type: "string", description: "用于限定查询范围的资料类型。" },
      limit: { type: "integer", description: "返回条数上限，默认 5。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const parsed = parseLookupInput(params);
    const toolContext = requireStateToolContext(ctx);
    const worldName = requireWorldName(toolContext.worldName);
    const results = searchLore(toolContext.db, worldName, parsed);
    return ok(formatLoreLookupResults(results), { results });
  }
};

function parseLookupInput(input: unknown): { query: string; kind?: string; limit?: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("lookup 需要对象 { query, kind?, limit? }。");
  }
  const record = input as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new TypeError("lookup 需要非空 query 文本。");
  }

  const parsed: { query: string; kind?: string; limit?: number } = { query };
  if (typeof record.kind === "string" && record.kind.trim() !== "") {
    parsed.kind = record.kind.trim();
  }
  const limit = normalizeLimit(record.limit);
  if (limit !== undefined) {
    parsed.limit = limit;
  }
  return parsed;
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
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
  return undefined;
}

function requireWorldName(worldName: string | undefined): string {
  if (!worldName) {
    throw new TypeError("lookup 需要状态工具上下文提供 worldName。");
  }
  return worldName;
}
