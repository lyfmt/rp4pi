import type { StateStore } from "../../state/store.ts";
import type { RpDatabase } from "../../state/sqlite.ts";
import type { ProjectionAudience, SystemRuntimeLifecycle } from "../../systems/types.ts";
import type { SystemRegistry } from "../../systems/registry.ts";
import type { AttributeSpec, WorldInitialState } from "../../world/schema.ts";
import type { StorySnapshotCoordinator } from "../../state/story-snapshot-coordinator.ts";

export type StateToolContext = {
  db: RpDatabase;
  stateStore: StateStore;
  systemRegistry?: SystemRegistry;
  systemRuntime?: SystemRuntimeLifecycle;
  storySnapshots?: StorySnapshotCoordinator;
  projectionAudience?: ProjectionAudience;
  piSessionId?: string;
  /** Attribute specs of the active world; drives update_attribute validation. */
  attributeSpecs?: AttributeSpec[];
  /** Fixed-core initial values of the active world; seeds initialize_new_game. */
  initialState?: WorldInitialState;
  /** Active world name; scopes fixed lore lookup tables. */
  worldName?: string;
  /** Project root, so save-bind points can re-project this save's forged roles
   * into `.pi/agents/` (dynamic-role materialization). */
  projectRoot?: string;
};

export function requireStateToolContext(context: unknown): StateToolContext {
  if (!isRecord(context) || !("db" in context) || !("stateStore" in context)) {
    throw new TypeError("状态工具上下文缺失：需要 { db, stateStore }，请检查工具是否经 registry 绑定。");
  }

  const db = context.db;
  const stateStore = context.stateStore;
  if (
    !isRecord(db) ||
    typeof db.prepare !== "function" ||
    typeof db.exec !== "function" ||
    !isRecord(stateStore) ||
    typeof stateStore.getState !== "function" ||
    typeof stateStore.replaceState !== "function" ||
    typeof stateStore.mutateState !== "function" ||
    typeof stateStore.getActiveSaveId !== "function"
  ) {
    throw new TypeError("状态工具上下文非法：db 或 stateStore 形状不匹配。");
  }

  if ("piSessionId" in context && context.piSessionId !== undefined && typeof context.piSessionId !== "string") {
    throw new TypeError("状态工具上下文非法：piSessionId 必须是字符串。");
  }

  if ("worldName" in context && context.worldName !== undefined && typeof context.worldName !== "string") {
    throw new TypeError("状态工具上下文非法：worldName 必须是字符串。");
  }

  return context as StateToolContext;
}

// 入口宽：LLM 经常把字段写成相邻类型（数字写成字符串、字符串写成数字）。
// 这些 reader 把模型自然表达 *归一化* 成领域类型，而不是对第一处偏差就抛错。
// 核心严仍在 engine/state reducer。只有真正无法归一化的值才报领域错误。

export function readString(input: Record<string, unknown>, key: string, fallback = ""): string {
  const value = input[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new TypeError(`${key} 需要文本，收到 ${describeType(value)}。`);
}

export function readRecord(value: unknown, key: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError(`${key} 需要对象，收到 ${describeType(value)}。`);
  }
  return value;
}

export function readInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  throw new TypeError(`${key} 需要整数，收到 ${describeType(value)}。`);
}

export function readBoolean(input: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  const value = input[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  throw new TypeError(`${key} 需要布尔值，收到 ${describeType(value)}。`);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
