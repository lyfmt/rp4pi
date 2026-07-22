// Shared runtime for `kind: role` subagents — the persistent single-character
// actors. Unlike a `tool` subagent (ephemeral, world-supplied tools), every
// role child gets THIS extension auto-attached at materialization time
// (materialize-subagents.ts), so a world author writes only a persona: the
// recall/remember machinery is the base platform's job, identical across worlds.
//
// A role child is a fresh Pi process with no memory of its past lives. It learns:
//   - which SAVE it belongs to        → RP_ACTIVE_SAVE (parent sets it; env inherited)
//   - which CHARACTER it is           → PI_SUBAGENT_CHILD_AGENT (pi-subagents sets
//                                        this to the spawned agent's name; the role
//                                        name IS the character identity — one
//                                        character per agent)
// With those two ids it reaches the shared sqlite trajectory store directly
// (same DB path the parent uses; no parent RPC needed), exactly as forge_character
// reaches OpenViking.
//
// The continuity loop ("the trajectory is inherited from its previous replies"):
//   1. recall_self   — reassemble prior self: rolling summary + verbatim tail,
//                      plus OV `characters` background is layered on by the
//                      persona/GM outside this module. If the tail or summary has
//                      grown past the char thresholds, recall asks the character
//                      to hand back a rewritten summary on its next remember_action.
//   2. remember_action — append this turn's action verbatim; if the character
//                      supplied an updated summary, fold it in, clamping the
//                      watermark strictly below the current (roll-undoable) turn.
//
// This module authors NO summary text itself (decided upstream: the role writes
// its own first-person summary). Harness here only stores, measures, and prompts.

import { loadRuntimeConfig } from "../runtime/config.ts";
import { findProjectRoot } from "../runtime/paths.ts";
import { readLatestState } from "../state/sqlite.ts";
import { openRpDatabase, type RpDatabase } from "../state/sqlite.ts";
import { latestStorySnapshotTurnNo } from "../state/snapshots.ts";
import {
  appendCharacterTrajectory,
  maxSeqBeforeTurn,
  recallTrajectory,
  writeCharacterSummary,
  type GameTime,
  type TrajectoryRecall
} from "../state/trajectory.ts";
import type { AgentToolResult, PiLike, ToolDefinition } from "../types/pi.ts";

type RoleResult = AgentToolResult<Record<string, unknown>>;

// Char-count thresholds (decided upstream: measure by characters, not entries).
// When the verbatim tail exceeds FOLD, recall asks the character to summarize its
// older actions into the rolling summary. When the summary itself exceeds
// COMPACT, recall asks the character to rewrite it more tightly. Both are
// advisory prompts — the character produces the new summary text on its next
// remember_action; harness never calls an LLM.
export const TAIL_FOLD_THRESHOLD_CHARS = 4000;
export const SUMMARY_COMPACT_THRESHOLD_CHARS = 2000;

/** The active (save, character) a role child is bound to, from its environment. */
export type RoleBinding = { saveId: string; character: string };

/** Resolve the role's save + character from env, or explain what is missing. */
export function resolveRoleBinding(env: NodeJS.ProcessEnv = process.env): RoleBinding | { reason: string } {
  const saveId = env.RP_ACTIVE_SAVE;
  if (!saveId) {
    return { reason: "no-active-save" };
  }
  const character = env.PI_SUBAGENT_CHILD_AGENT;
  if (!character) {
    return { reason: "no-character-identity" };
  }
  return { saveId, character };
}

/** The maintenance the character should perform, derived purely from sizes. */
export type MaintenanceHint = {
  tailChars: number;
  summaryChars: number;
  needsFold: boolean;
  needsCompact: boolean;
};

export function assessMaintenance(recall: TrajectoryRecall): MaintenanceHint {
  const tailChars = recall.tail.reduce((sum, e) => sum + e.content.length, 0);
  const summaryChars = recall.summary?.summary.length ?? 0;
  return {
    tailChars,
    summaryChars,
    needsFold: tailChars > TAIL_FOLD_THRESHOLD_CHARS,
    needsCompact: summaryChars > SUMMARY_COMPACT_THRESHOLD_CHARS
  };
}

/** Render a recall into the text a role child reads to resume being itself. */
export function renderRecall(recall: TrajectoryRecall, character: string): string {
  const lines: string[] = [`【${character} · 既往轨迹】`];

  if (recall.summary) {
    lines.push(`〔摘要，截至第 ${recall.summary.lastDay} 天 ${recall.summary.lastHour} 时〕`);
    lines.push(recall.summary.summary.trim());
  } else {
    lines.push("〔尚无摘要——这是你最初的若干次行动〕");
  }

  if (recall.tail.length > 0) {
    lines.push("");
    lines.push("〔此后逐条原文，最早在前〕");
    for (const e of recall.tail) {
      lines.push(`- [第 ${e.gameDay} 天 ${e.gameHour} 时] ${e.content}`);
    }
  } else if (recall.summary) {
    lines.push("");
    lines.push("〔摘要之后暂无新行动〕");
  }

  const hint = assessMaintenance(recall);
  const notes: string[] = [];
  if (hint.needsFold) {
    notes.push(
      "你的原文尾巴已较长:下次调用 remember_action 时,请在 summary 参数里给出一段更新后的第一人称摘要,把较早的行动并入摘要。"
    );
  }
  if (hint.needsCompact) {
    notes.push("你的摘要本身已偏长:下次给出 summary 时请重写得更精炼,保留关键承诺、关系与未了之事,删去细枝末节。");
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push(`〔记忆维护提醒〕${notes.join(" ")}`);
  }

  return lines.join("\n");
}

export type RememberInput = { content: string; summary?: string };

export function parseRememberInput(input: unknown): RememberInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("remember_action 需要对象 { content, summary? }。");
  }
  const record = input as Record<string, unknown>;
  const content = record.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new TypeError("remember_action 需要非空 content(本回合你的行动,第一人称原文)。");
  }
  const summaryRaw = record.summary;
  const summary = typeof summaryRaw === "string" && summaryRaw.trim() !== "" ? summaryRaw.trim() : undefined;
  return { content: content.trim(), summary };
}

/** In-game clock for a save, defaulting to day 1 hour 8 if state is absent. */
function gameTimeForSave(db: RpDatabase, saveId: string): GameTime {
  const state = readLatestState(db, saveId);
  return { day: state?.time.day ?? 1, hour: state?.time.hour ?? 8 };
}

function roleResult(text: string, details: Record<string, unknown>): RoleResult {
  return { content: [{ type: "text", text }], details };
}

// A role child opens the shared DB itself (fresh process). busy_timeout guards
// the rare window where the parent commits a snapshot while the child writes its
// trajectory — SQLite retries instead of erroring under the cross-process lock.
function openSharedDatabase(): RpDatabase {
  const db = openRpDatabase(loadRuntimeConfig(findProjectRoot(import.meta.url)).sqlitePath);
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

export const recallSelfTool: ToolDefinition<RoleResult> = {
  name: "recall_self",
  label: "回溯自身",
  description:
    "回溯你(本角色)在本存档中的既往轨迹:滚动摘要 + 此后逐条原文。\n\n" +
    "用法:每次被唤起、开口扮演前先调用一次,据此保持与过去言行一致。\n" +
    "若返回里出现「记忆维护提醒」,按提示在下次 remember_action 的 summary 参数里更新摘要。",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<RoleResult> {
    const binding = resolveRoleBinding();
    if ("reason" in binding) {
      return roleResult(unavailableText(binding.reason), { available: false, reason: binding.reason });
    }
    const db = openSharedDatabase();
    try {
      const recall = recallTrajectory(db, binding.saveId, binding.character);
      const hint = assessMaintenance(recall);
      return roleResult(renderRecall(recall, binding.character), {
        available: true,
        character: binding.character,
        entryCount: recall.tail.length,
        hasSummary: recall.summary !== undefined,
        ...hint
      });
    } finally {
      db.close();
    }
  }
};

export const rememberActionTool: ToolDefinition<RoleResult> = {
  name: "remember_action",
  label: "记录行动",
  description:
    "把你(本角色)本回合的行动/发言作为原文追加进自己的轨迹,供下次唤起时继承。\n\n" +
    "用法:本回合扮演结束时调用一次,content 用第一人称原文。\n" +
    "维护:若 recall_self 提示尾巴/摘要过长,请一并给出 summary(更新后的第一人称摘要),系统会把较早行动折进摘要。",
  parameters: {
    type: "object",
    required: ["content"],
    properties: {
      content: { type: "string", description: "本回合你的行动或发言,第一人称原文。" },
      summary: {
        type: "string",
        description: "可选。更新后的第一人称滚动摘要;仅在被提示需要折叠/压缩时给出。"
      }
    }
  },
  async execute(_toolCallId, params): Promise<RoleResult> {
    const input = parseRememberInput(params);
    const binding = resolveRoleBinding();
    if ("reason" in binding) {
      return roleResult(unavailableText(binding.reason), { persisted: false, reason: binding.reason });
    }
    const db = openSharedDatabase();
    try {
      // The turn currently being composed = latest committed + 1. Tagging the
      // action with it lets a later /roll prune exactly this turn's actions.
      const currentTurn = latestStorySnapshotTurnNo(db, binding.saveId) + 1;
      const gameTime = gameTimeForSave(db, binding.saveId);
      const seq = appendCharacterTrajectory(db, binding.saveId, {
        character: binding.character,
        turnNo: currentTurn,
        content: input.content,
        gameTime
      });

      let folded = false;
      if (input.summary) {
        // Fold: the summary may cover only entries from turns already committed
        // (strictly before the current turn), so a /roll of the current turn can
        // never contradict it. This turn's just-appended action stays as tail.
        const watermark = maxSeqBeforeTurn(db, binding.saveId, binding.character, currentTurn);
        writeCharacterSummary(db, binding.saveId, {
          character: binding.character,
          summary: input.summary,
          coversUpToSeq: watermark,
          lastTime: gameTime
        });
        folded = true;
      }

      return roleResult(
        folded
          ? `已记录本回合行动(seq ${seq}),并更新了你的滚动摘要。`
          : `已记录本回合行动(seq ${seq})。`,
        { persisted: true, character: binding.character, seq, folded }
      );
    } finally {
      db.close();
    }
  }
};

function unavailableText(reason: string): string {
  if (reason === "no-active-save") {
    return "无法访问你的轨迹:未能确定当前存档(RP_ACTIVE_SAVE 未设置)。请在有存档的回合内被唤起。";
  }
  if (reason === "no-character-identity") {
    return "无法确定你是谁(PI_SUBAGENT_CHILD_AGENT 未设置)。role 子代理应由 subagent 工具按名唤起。";
  }
  return `无法访问你的轨迹:${reason}。`;
}

export function activate(pi: PiLike): void {
  pi.registerTool(recallSelfTool);
  pi.registerTool(rememberActionTool);
}

export default activate;
