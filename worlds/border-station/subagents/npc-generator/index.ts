// Child-only tool extension for the border-station `npc-generator` subagent.
//
// It is materialized into `.pi/agents/npc-generator.md` as `subagentOnlyExtensions`,
// so pi-subagents loads it ONLY inside the spawned child process — `forge_character`
// never appears on the GM's own tool surface (least privilege / isolation).
//
// The child is a fresh Pi process with no access to the parent's save binding,
// so it learns the active save from `RP_ACTIVE_SAVE` (the parent sets it when a
// save is bound; pi-subagents spawns children with the parent's env inherited).
// The save id is all it needs: OpenViking scopes memories by user space
// (`save-<id>`), so a forged NPC lands in the current save's `characters` space
// regardless of which OV session ingests it.
import { createConfiguredOpenVikingClient } from "../../../../src/ov/configured-client.ts";
import { userSpaceForSave } from "../../../../src/ov/uri.ts";
import { findProjectRoot } from "../../../../src/runtime/paths.ts";
import type { AgentToolResult, PiLike, ToolDefinition } from "../../../../src/types/pi.ts";

type ForgeResult = AgentToolResult<Record<string, unknown>>;

type Npc = { name: string; summary: string; lastSeen?: string };

// OV writes are extraction-based: we ingest a short "a named character exists"
// turn under the save's user space and commit, letting OV extract it into the
// characters schema. (The project's OV model is "memory emerges from committed
// turns"; there is no direct memory-file write API.)
const CHARACTERS_POLICY = { memory_types: ["characters"] };

export const forgeCharacterTool: ToolDefinition<ForgeResult> = {
  name: "forge_character",
  label: "落库角色",
  description:
    "把一个新 NPC 落进当前存档的 characters 长期记忆。\n\n" +
    "用法:给出角色 name、summary(稳定身份/关系/持有物/承诺/已知状态),可选 last_seen(最近登场情境)。\n" +
    "边界:只用于确需长期记住的具名角色;“守卫/村民”等无名群体不要落库。",
  parameters: {
    type: "object",
    required: ["name", "summary"],
    properties: {
      name: { type: "string", description: "角色姓名或称呼(单角色单文件)。" },
      summary: { type: "string", description: "稳定身份、关系、持有物、承诺、已知状态摘要。" },
      last_seen: { type: "string", description: "最近一次明确出现或被提到的情境(可选)。" }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<ForgeResult> {
    const npc = parseForgeInput(params);

    const saveId = process.env.RP_ACTIVE_SAVE;
    if (!saveId) {
      return forgeResult("落库失败:未能确定当前存档(RP_ACTIVE_SAVE 未设置)。请在有存档的回合内委派本子代理。", {
        persisted: false,
        reason: "no-active-save"
      });
    }

    const client = createConfiguredOpenVikingClient(findProjectRoot(import.meta.url))?.forUser(userSpaceForSave(saveId));
    if (!client) {
      return forgeResult("落库失败:长期记忆(OpenViking)未配置或已禁用,NPC 未持久化。", {
        persisted: false,
        reason: "no-ov-client"
      });
    }

    try {
      const sessionId = `forge-${saveId}-${Date.now()}`;
      await client.ensureSession(sessionId, { memoryPolicy: CHARACTERS_POLICY });
      await client.addSessionMessage(sessionId, "user", `登记一名新角色:${npc.name}。`);
      await client.addSessionMessage(sessionId, "assistant", renderNpcProse(npc));
      const commit = await client.commitSession(sessionId, { keepRecentCount: 0 });
      return forgeResult(`已把「${npc.name}」提交到当前存档的 characters 记忆(抽取任务 ${commit.taskId ?? "已提交"})。`, {
        persisted: true,
        name: npc.name,
        taskId: commit.taskId
      });
    } catch (error) {
      return forgeResult(`落库失败:写入 OpenViking 出错——${error instanceof Error ? error.message : String(error)}`, {
        persisted: false,
        reason: "ov-error"
      });
    }
  }
};

export function renderNpcProse(npc: Npc): string {
  const lines = [`${npc.name}——${npc.summary}`];
  if (npc.lastSeen) {
    lines.push(`最近登场:${npc.lastSeen}`);
  }
  return lines.join("\n");
}

export function parseForgeInput(input: unknown): Npc {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("forge_character 需要对象 { name, summary, last_seen? }。");
  }
  const record = input as Record<string, unknown>;
  const name = record.name;
  const summary = record.summary;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("forge_character 需要非空 name。");
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new TypeError("forge_character 需要非空 summary。");
  }
  const lastSeenRaw = record.last_seen;
  const lastSeen = typeof lastSeenRaw === "string" && lastSeenRaw.trim() !== "" ? lastSeenRaw.trim() : undefined;
  return { name: name.trim(), summary: summary.trim(), lastSeen };
}

function forgeResult(text: string, details: Record<string, unknown>): ForgeResult {
  return { content: [{ type: "text", text }], details };
}

export function activate(pi: PiLike): void {
  pi.registerTool(forgeCharacterTool);
}

export default activate;
