import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createSearchablePickerComponent, type SearchablePickerItem } from "./save-picker-component.ts";
import {
  resolveSessionId,
  type ExtensionCommandContextLike,
  type PiLike,
  type PiModelLike
} from "../types/pi.ts";

export type RpModelRef = {
  provider: string;
  id: string;
};

export type RpSubagentModelTarget = {
  name: string;
  model?: string;
  thinking?: string;
};

export type WriterAgentStage = "styleEnhancer" | "inertiaCritic" | "clicheCritic";

type RpModelTargetBase = {
  id: string;
  label: string;
  current?: RpModelRef;
  thinking?: string;
};

export type RpModelTarget =
  | (RpModelTargetBase & { kind: "writer"; id: "writer" })
  | (RpModelTargetBase & { kind: "writerAgent"; stage: WriterAgentStage })
  | (RpModelTargetBase & { kind: "subagent"; name: string });

type JsonRecord = Record<string, unknown>;

const WRITER_AGENT_TARGETS: ReadonlyArray<{ stage: WriterAgentStage; label: string }> = [
  { stage: "styleEnhancer", label: "文风增强" },
  { stage: "inertiaCritic", label: "惯性审稿" },
  { stage: "clicheCritic", label: "八股审稿" }
];

export type RpConfigRegistrationContext = {
  projectRoot?: string;
  getSubagents?: (
    piSessionId: string
  ) => readonly RpSubagentModelTarget[] | Promise<readonly RpSubagentModelTarget[]>;
  onSubagentsChanged?: (piSessionId: string) => void | Promise<void>;
};

export function registerRpConfigCommand(pi: PiLike, context: RpConfigRegistrationContext): void {
  pi.registerCommand("rpconfig", {
    description: "Configure Writer, revision, and RP subagent models.",
    async handler(_args, ctx) {
      try {
        const piSessionId = resolveSessionId(ctx);
        if (piSessionId === undefined) {
          throw new Error("没有当前会话，无法配置模型。");
        }
        if (context.projectRoot === undefined) {
          throw new Error("项目根目录不可用，无法写入模型配置。");
        }
        if (ctx.ui?.select === undefined) {
          throw new Error("当前运行模式不支持交互式模型配置。");
        }
        const registry = ctx.modelRegistry;
        if (registry?.getAvailable === undefined) {
          throw new Error("Pi 模型注册表不可用。");
        }

        const subagents = (await context.getSubagents?.(piSessionId)) ?? [];
        const targets = listRpModelTargets(context.projectRoot, subagents);
        const targetItems = targets.map((target) => ({
          id: target.id,
          label: `${target.label}  当前：${formatModelRef(target.current)}`
        }));
        const targetId = await pickItem(ctx, "选择要配置的模块", targetItems, "没有可配置的 RP 模块");
        if (targetId === undefined) {
          return;
        }
        const target = targets.find((candidate) => candidate.id === targetId);
        if (target === undefined) {
          throw new Error("选择的配置目标已失效，请重试。");
        }

        registry.refresh?.();
        const available = normalizeAvailableModels(await registry.getAvailable());
        if (available.length === 0) {
          const detail = registry.getError?.();
          throw new Error(detail ? `没有可用模型：${detail}` : "没有已认证的可用模型，请先使用 /login。");
        }
        const models = sortModelsForTarget(available, target.current);
        const modelItems = models.map((model) => ({
          id: modelKey(model),
          label: `${model.id} [${model.provider}]${sameModel(model, target.current) ? "  ✓" : ""}`
        }));
        const selectedKey = await pickItem(
          ctx,
          `为「${target.label}」选择模型`,
          modelItems,
          "没有匹配的可用模型"
        );
        if (selectedKey === undefined) {
          return;
        }
        const selected = models.find((model) => modelKey(model) === selectedKey);
        if (selected === undefined) {
          throw new Error("选择的模型已失效，请重试。");
        }

        writeRpModelSelection(context.projectRoot, target, selected);
        if (target.kind === "subagent") {
          try {
            await context.onSubagentsChanged?.(piSessionId);
          } catch (error) {
            throw new Error(
              `模型配置已保存，但子代理配置刷新失败：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        ctx.ui.notify(`已将「${target.label}」设置为 ${selected.provider}/${selected.id}。`, "info");
      } catch (error) {
        ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });
}

export function listRpModelTargets(
  projectRoot: string,
  subagents: readonly RpSubagentModelTarget[]
): RpModelTarget[] {
  const settings = readSettings(projectRoot);
  const defaultProvider = optionalString(settings.defaultProvider);
  const defaultModelId = optionalString(settings.defaultModel);
  const defaultModel =
    defaultProvider !== undefined && defaultModelId !== undefined
      ? { provider: defaultProvider, id: defaultModelId }
      : undefined;
  const writerEntry = optionalRecord(settings.writer, "writer");
  const writerModel = modelRefFromEntry(writerEntry ?? {}, defaultModel);
  const writerThinking = optionalString(writerEntry?.thinking);
  const writerAgents = optionalRecord(settings.writerAgents, "writerAgents");

  const targets: RpModelTarget[] = [
    {
      kind: "writer",
      id: "writer",
      label: "Writer（正文与重写）",
      current: writerModel,
      thinking: writerThinking
    }
  ];

  for (const { stage, label } of WRITER_AGENT_TARGETS) {
    const entry = optionalRecord(writerAgents?.[stage], `writerAgents.${stage}`);
    targets.push({
      kind: "writerAgent",
      id: `writerAgents.${stage}`,
      stage,
      label,
      current: modelRefFromEntry(entry ?? {}, writerModel),
      thinking: optionalString(entry?.thinking) ?? writerThinking
    });
  }

  const legacySubagents = optionalRecord(settings.subagents, "subagents");
  const rpSubagents = optionalRecord(settings.rpSubagents, "rpSubagents");
  const seen = new Set<string>();
  for (const subagent of subagents) {
    if (seen.has(subagent.name)) {
      continue;
    }
    seen.add(subagent.name);

    const legacyOverride = modelSettingsEntry(legacySubagents?.[subagent.name], `subagents.${subagent.name}`);
    const override = modelSettingsEntry(rpSubagents?.[subagent.name], `rpSubagents.${subagent.name}`) ?? legacyOverride;
    const declaredModel = parseCanonicalModelRef(subagent.model);
    targets.push({
      kind: "subagent",
      id: `rpSubagents.${subagent.name}`,
      name: subagent.name,
      label: `子代理：${subagent.name}`,
      current: subagentModelRef(override, declaredModel ?? defaultModel),
      thinking: optionalString(override?.thinking) ?? subagent.thinking
    });
  }

  return targets;
}

export function writeRpModelSelection(
  projectRoot: string,
  target: RpModelTarget,
  selected: RpModelRef
): void {
  const provider = requireNonEmpty(selected.provider, "provider");
  const model = requireNonEmpty(selected.id, "model id");
  const settings = readSettings(projectRoot);

  if (target.kind === "writer") {
    const entry = ensureRecord(settings, "writer");
    entry.provider = provider;
    entry.model = model;
  } else if (target.kind === "writerAgent") {
    const writerAgents = ensureRecord(settings, "writerAgents");
    const entry = ensureRecord(writerAgents, target.stage, `writerAgents.${target.stage}`);
    entry.provider = provider;
    entry.model = model;
    if (entry.thinking === undefined && target.thinking !== undefined) {
      entry.thinking = target.thinking;
    }
  } else {
    const rpSubagents = ensureRecord(settings, "rpSubagents");
    const entry = ensureRecord(rpSubagents, target.name, `rpSubagents.${target.name}`);
    delete entry.provider;
    entry.model = `${provider}/${model}`;
  }

  writeSettings(projectRoot, settings);
}

function settingsPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "agent", "settings.json");
}

function readSettings(projectRoot: string): JsonRecord {
  const path = settingsPath(projectRoot);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeSettings(projectRoot: string, settings: JsonRecord): void {
  const path = settingsPath(projectRoot);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tempPath = join(dir, `.settings.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function modelRefFromEntry(entry: JsonRecord, fallback?: RpModelRef): RpModelRef | undefined {
  const provider = optionalString(entry.provider) ?? fallback?.provider;
  const id = optionalString(entry.model) ?? fallback?.id;
  return provider !== undefined && id !== undefined ? { provider, id } : undefined;
}

function subagentModelRef(entry: JsonRecord | undefined, fallback?: RpModelRef): RpModelRef | undefined {
  const model = optionalString(entry?.model);
  if (model === undefined) {
    return fallback;
  }
  const provider = optionalString(entry?.provider);
  if (provider !== undefined) {
    return { provider, id: model };
  }
  return parseCanonicalModelRef(model) ?? fallback;
}

function parseCanonicalModelRef(value: string | undefined): RpModelRef | undefined {
  const model = optionalString(value);
  if (model === undefined) {
    return undefined;
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return undefined;
  }
  return { provider: model.slice(0, separator), id: model.slice(separator + 1) };
}

function modelSettingsEntry(value: unknown, field: string): JsonRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.provider === undefined && value.model === undefined && value.thinking === undefined) {
    return undefined;
  }
  return optionalRecord(value, field);
}

function optionalRecord(value: unknown, field: string): JsonRecord | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Settings field "${field}" must be an object.`);
  }
  return value;
}

function ensureRecord(parent: JsonRecord, key: string, field = key): JsonRecord {
  const existing = parent[key];
  if (existing === undefined || existing === null) {
    const created: JsonRecord = {};
    parent[key] = created;
    return created;
  }
  if (!isRecord(existing)) {
    throw new Error(`Settings field "${field}" must be an object.`);
  }
  return existing;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    throw new Error(`Selected model ${field} must be a non-empty string.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pickItem(
  ctx: ExtensionCommandContextLike,
  title: string,
  items: readonly SearchablePickerItem[],
  emptyText: string
): Promise<string | undefined> {
  if (ctx.mode === "tui" && ctx.ui?.custom !== undefined) {
    return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
      createSearchablePickerComponent(items, tui, theme, keybindings, done, { title, emptyText })
    );
  }
  if (ctx.ui?.select === undefined) {
    return undefined;
  }
  const labels = items.map((item) => item.label);
  const selectedLabel = await ctx.ui.select(title, labels);
  return items.find((item) => item.label === selectedLabel)?.id;
}

function normalizeAvailableModels(models: readonly PiModelLike[]): PiModelLike[] {
  const unique = new Map<string, PiModelLike>();
  for (const model of models) {
    if (
      typeof model === "object" &&
      model !== null &&
      optionalString(model.provider) !== undefined &&
      optionalString(model.id) !== undefined
    ) {
      unique.set(modelKey(model), model);
    }
  }
  return [...unique.values()];
}

function sortModelsForTarget(models: readonly PiModelLike[], current: RpModelRef | undefined): PiModelLike[] {
  return [...models].sort((left, right) => {
    const leftCurrent = sameModel(left, current);
    const rightCurrent = sameModel(right, current);
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }
    return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
  });
}

function sameModel(model: RpModelRef, current: RpModelRef | undefined): boolean {
  return current !== undefined && model.provider === current.provider && model.id === current.id;
}

function modelKey(model: RpModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

function formatModelRef(model: RpModelRef | undefined): string {
  return model === undefined ? "未配置（继承 Pi 默认）" : `${model.provider}/${model.id}`;
}
