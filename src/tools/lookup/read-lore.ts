import { getLoreEntry } from "../../lore/sqlite.ts";
import type { ToolDefinition } from "../../types/pi.ts";
import { ok, type ToolResult } from "../runtime/result.ts";
import { requireStateToolContext } from "../state/context.ts";

export const readLoreTool: ToolDefinition<ToolResult> = {
  name: "read_lore",
  label: "RP 资料",
  description: "按设定条目标识读取当前世界中的一条完整设定。",
  parameters: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "查询结果返回的设定条目标识，原样传入。" }
    }
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const id = parseReadLoreInput(params);
    const toolContext = requireStateToolContext(ctx);
    const worldName = requireWorldName(toolContext.worldName);
    const entry = getLoreEntry(toolContext.db, worldName, id);
    if (!entry) {
      return ok(`未找到固定资料：${id}`, { id, entry: undefined });
    }
    return ok(formatLoreEntry(entry), { id, entry });
  }
};

type LoreEntry = NonNullable<ReturnType<typeof getLoreEntry>>;

function formatLoreEntry(entry: LoreEntry): string {
  const lines = [`### [${entry.kind}] ${entry.name} - ${entry.id}`, entry.summary];
  if (entry.aliases.length > 0) {
    lines.push("", `别名：${entry.aliases.join("、")}`);
  }
  if (entry.body.trim() !== "") {
    lines.push("", entry.body);
  }
  const fields = Object.entries(entry.fields);
  if (fields.length > 0) {
    lines.push("", "字段：", ...fields.map(([key, value]) => `- ${key}: ${String(value)}`));
  }
  if (entry.relations.length > 0) {
    lines.push("", "关系：", ...entry.relations.map((relation) => `- ${relation.type} -> ${relation.target}${relation.note ? `：${relation.note}` : ""}`));
  }
  return lines.join("\n");
}

function parseReadLoreInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("read_lore 需要对象 { id }。");
  }
  const id = (input as Record<string, unknown>).id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("read_lore 需要非空 id 文本。");
  }
  return id.trim();
}

function requireWorldName(worldName: string | undefined): string {
  if (!worldName) {
    throw new TypeError("read_lore 需要状态工具上下文提供 worldName。");
  }
  return worldName;
}
