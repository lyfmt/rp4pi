import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SubagentSpec } from "./schema.ts";

export type SubagentModelSettings = {
  model?: string;
  thinking?: string;
};

export type SubagentSettingsMap = Record<string, SubagentModelSettings>;

/** Read user-owned per-subagent model overrides from `.pi/agent/settings.json`.
 *
 * The world pack remains authoritative for persona, tools, extensions and kind.
 * Settings only expose local model choices to users:
 *
 *   "rpSubagents": {
 *     "npc-generator": { "provider": "opencode-go", "model": "deepseek-v4-pro", "thinking": "high" },
 *     "actor": { "model": "opencode-go/deepseek-v4-pro" }
 *   }
 */
export function readSubagentSettings(projectRoot: string): SubagentSettingsMap {
  const settingsPath = join(projectRoot, ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not parse ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = asRecord(parsed, "settings.json");
  return {
    ...parseSubagentMap(root.subagents, "subagents", { skipNonObjectEntries: true }),
    ...parseSubagentMap(root.rpSubagents, "rpSubagents", { skipNonObjectEntries: false })
  };
}

function parseSubagentMap(value: unknown, field: string, options: { skipNonObjectEntries: boolean }): SubagentSettingsMap {
  if (value === undefined || value === null) {
    return {};
  }
  const rawSubagents = asRecord(value, field);
  const settings: SubagentSettingsMap = {};
  for (const [name, value] of Object.entries(rawSubagents)) {
    const entryField = `${field}.${name}`;
    if (options.skipNonObjectEntries && !isRecord(value)) {
      continue;
    }
    const entry = asRecord(value, entryField);
    if (options.skipNonObjectEntries && !hasModelSettingsFields(entry)) {
      continue;
    }
    const provider = optionalNonEmptyString(entry.provider, `${entryField}.provider`);
    const model = parseModel(provider, optionalNonEmptyString(entry.model, `${entryField}.model`), `${entryField}.model`);
    const thinking = optionalNonEmptyString(entry.thinking, `${entryField}.thinking`);

    const parsedSettings: SubagentModelSettings = {};
    if (model !== undefined) {
      parsedSettings.model = model;
    }
    if (thinking !== undefined) {
      parsedSettings.thinking = thinking;
    }
    if (Object.keys(parsedSettings).length > 0) {
      settings[name] = parsedSettings;
    }
  }
  return settings;
}

export function applySubagentSettings(spec: SubagentSpec, settings: SubagentModelSettings | undefined): SubagentSpec {
  if (settings === undefined) {
    return spec;
  }
  return {
    ...spec,
    model: settings.model ?? spec.model,
    thinking: settings.thinking ?? spec.thinking
  };
}

function parseModel(provider: string | undefined, model: string | undefined, field: string): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  if (provider !== undefined) {
    if (model.includes("/")) {
      throw new Error(`Settings field "${field}" must be a bare model id when provider is also set.`);
    }
    return `${provider}/${model}`;
  }
  if (!model.includes("/")) {
    throw new Error(`Settings field "${field}" must be provider/model, or set provider alongside a bare model id.`);
  }
  return model;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Settings field "${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasModelSettingsFields(value: Record<string, unknown>): boolean {
  return value.provider !== undefined || value.model !== undefined || value.thinking !== undefined;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Settings field "${field}" must be a non-empty string.`);
  }
  return value.trim();
}
