// Base-platform child-only tool: forge a NEW playable role subagent mid-game.
//
// A world's `role-forger` subagent (tool-kind, least-privilege allowlist of just
// `forge_role`) calls this after composing a persona. It is the role twin of
// forge_character: where that lands only a `characters` memory, this ALSO
// persists a playable role and projects it into `.pi/agents/` so the GM can
// immediately delegate to the freshly-forged character in the same session
// (pi-subagents rediscovers `.pi/agents/` on every spawn — no restart needed).
//
// What one forge does, all scoped to the active save (RP_ACTIVE_SAVE, inherited
// from the parent like forge_character):
//   1. persist the role to `dynamic_roles` (source of truth, save-scoped);
//   2. re-materialize the save's forged roles into `.pi/agents/<name>.md`
//      (role-kind → auto-gets recall_self/remember_action + role-runtime);
//   3. land a `characters` OV memory so search_memory can surface the new NPC's
//      objective identity (trajectory holds its first-person continuity; the two
//      are complementary — see role-runtime.ts).
import { createConfiguredOpenVikingClient } from "../ov/configured-client.ts";
import { userSpaceForSave } from "../ov/uri.ts";
import { loadRuntimeConfig } from "../runtime/config.ts";
import { findProjectRoot } from "../runtime/paths.ts";
import { upsertDynamicRole } from "../state/dynamic-roles.ts";
import { openRpDatabase, type RpDatabase } from "../state/sqlite.ts";
import { materializeDynamicRoles } from "../world/materialize-dynamic-roles.ts";
import type { AgentToolResult, PiLike, ToolDefinition } from "../types/pi.ts";

type ForgeRoleResult = AgentToolResult<Record<string, unknown>>;

type RoleInput = { name: string; description: string; persona: string; summary: string };

const CHARACTERS_POLICY = { memory_types: ["characters"] };

export const forgeRoleTool: ToolDefinition<ForgeRoleResult> = {
  name: "forge_role",
  label: "铸造角色",
  description:
    "把一个新的【可扮演角色】落进当前存档:既登记为可被 GM 委派扮演的 role 子代理,又写入 characters 长期记忆。\n\n" +
    "用法:给出 name(角色名/称呼,作为该角色的唯一标识)、description(一句话职责,供 GM 挑选)、" +
    "persona(第二人称写给该角色本人的完整人设:你是谁、性格、动机、边界)、summary(客观身份/关系/持有物摘要,写进 characters)。\n" +
    "边界:只为确需长期扮演的具名角色铸造;临时路人不必。",
  parameters: {
    type: "object",
    required: ["name", "description", "persona", "summary"],
    properties: {
      name: { type: "string", description: "角色名或称呼,作为唯一标识(单角色单代理)。" },
      description: { type: "string", description: "一句话职责,供 GM 在委派时挑选。" },
      persona: { type: "string", description: "写给该角色本人的完整人设(第二人称):身份、性格、动机、行动边界。" },
      summary: { type: "string", description: "客观身份、关系、持有物、承诺、已知状态摘要,写进 characters 记忆。" }
    }
  },
  async execute(_toolCallId, params): Promise<ForgeRoleResult> {
    const role = parseForgeRoleInput(params);

    const saveId = process.env.RP_ACTIVE_SAVE;
    if (!saveId) {
      return forgeRoleResult("铸造失败:未能确定当前存档(RP_ACTIVE_SAVE 未设置)。请在有存档的回合内委派。", {
        persisted: false,
        reason: "no-active-save"
      });
    }

    const projectRoot = findProjectRoot(import.meta.url);
    const db: RpDatabase = openRpDatabase(loadRuntimeConfig(projectRoot).sqlitePath);
    db.exec("PRAGMA busy_timeout = 3000");
    let materialized: string[];
    try {
      upsertDynamicRole(db, saveId, { name: role.name, description: role.description, persona: role.persona });
      // Re-project the save's forged roles so the new one is discoverable now.
      // A name collision with a world subagent / hand file surfaces here.
      materialized = materializeDynamicRoles(projectRoot, db, saveId);
    } catch (error) {
      db.close();
      return forgeRoleResult(`铸造失败:${error instanceof Error ? error.message : String(error)}`, {
        persisted: false,
        reason: "materialize-error"
      });
    }
    db.close();

    // Land the objective identity into characters memory (best-effort; a role is
    // still playable via its persona + trajectory even if OV is off).
    const memory = await landCharacterMemory(projectRoot, saveId, role);

    return forgeRoleResult(
      `已铸造可扮演角色「${role.name}」:已登记为 role 子代理(可立即委派),${memory.text}`,
      { persisted: true, name: role.name, agentFileCount: materialized.length, characters: memory.details }
    );
  }
};

async function landCharacterMemory(
  projectRoot: string,
  saveId: string,
  role: RoleInput
): Promise<{ text: string; details: Record<string, unknown> }> {
  const client = createConfiguredOpenVikingClient(projectRoot)?.forUser(userSpaceForSave(saveId));
  if (!client) {
    return { text: "characters 记忆未写入(OpenViking 未配置或已禁用)。", details: { persisted: false, reason: "no-ov-client" } };
  }
  try {
    const sessionId = `forge-role-${saveId}-${Date.now()}`;
    await client.ensureSession(sessionId, { memoryPolicy: CHARACTERS_POLICY });
    await client.addSessionMessage(sessionId, "user", `登记一名新角色:${role.name}。`);
    await client.addSessionMessage(sessionId, "assistant", `${role.name}——${role.summary}`);
    const commit = await client.commitSession(sessionId, { keepRecentCount: 0 });
    return {
      text: `并已提交到 characters 记忆(抽取任务 ${commit.taskId ?? "已提交"})。`,
      details: { persisted: true, taskId: commit.taskId }
    };
  } catch (error) {
    return {
      text: `但写入 characters 记忆出错——${error instanceof Error ? error.message : String(error)}。`,
      details: { persisted: false, reason: "ov-error" }
    };
  }
}

export function parseForgeRoleInput(input: unknown): RoleInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("forge_role 需要对象 { name, description, persona, summary }。");
  }
  const record = input as Record<string, unknown>;
  const name = requireField(record.name, "name");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new TypeError(`forge_role 的 name 必须是 slug(字母、数字、-、_);收到 "${name}"。角色名请用拼音/英文标识,展示名放进 persona。`);
  }
  return {
    name,
    description: requireField(record.description, "description"),
    persona: requireField(record.persona, "persona"),
    summary: requireField(record.summary, "summary")
  };
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`forge_role 需要非空 ${field}。`);
  }
  return value.trim();
}

function forgeRoleResult(text: string, details: Record<string, unknown>): ForgeRoleResult {
  return { content: [{ type: "text", text }], details };
}

export function activate(pi: PiLike): void {
  pi.registerTool(forgeRoleTool);
}

export default activate;
