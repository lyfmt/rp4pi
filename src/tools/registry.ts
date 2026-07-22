import { createRequire } from "node:module";
import { activateSave } from "../state/active-save.ts";
import { getBoundSave } from "../state/session-binding.ts";
import { resolveSessionId, type ExtensionContextLike, type PiLike, type ToolDefinition } from "../types/pi.ts";
import type { StateToolContext } from "./state/context.ts";
import type { OpenVikingToolContext } from "../ov/search-tools.ts";
import { readMemoryTool } from "./lookup/read-memory.ts";
import { searchMemoryTool } from "./lookup/search-memory.ts";
import { lookupLoreTool } from "./lookup/lookup-lore.ts";
import { readLoreTool } from "./lookup/read-lore.ts";
import { initializeNewGameTool } from "./state/initialize-new-game.ts";
import { getStatusTool } from "./state/get-status.ts";
import { commitTurnTool } from "./state/commit-turn.ts";
import { updateLocationTool } from "./state/update-location.ts";
import { updatePlayerStatusTool } from "./state/update-player-status.ts";
import { updateSceneTool } from "./state/update-scene.ts";
import { updateTimeTool } from "./state/update-time.ts";
import { submitDirectionPacketTool } from "./state/submit-direction-packet.ts";
import { updateAttributeTool } from "./state/update-attribute.ts";

const DEFAULT_TOOL_LABEL = "RP";

const stateTools: ToolDefinition[] = [
  getStatusTool,
  commitTurnTool,
  initializeNewGameTool,
  updateLocationTool,
  updatePlayerStatusTool,
  updateTimeTool,
  updateSceneTool,
  updateAttributeTool,
  submitDirectionPacketTool
];

const memoryTools: ToolDefinition[] = [searchMemoryTool, readMemoryTool];
const lookupTools: ToolDefinition[] = [lookupLoreTool, readLoreTool];

const requireToolModule = createRequire(import.meta.url);

export type WorldToolRegistration = {
  include?: string[];
  extra?: string[];
};

const builtinToolGroups: Record<string, ToolDefinition[]> = {
  "core.state": stateTools,
  "core.memory": memoryTools,
  "core.lookup": lookupTools
};

export function registerAllTools(
  pi: PiLike,
  stateContext?: StateToolContext,
  ovContext?: OpenVikingToolContext,
  worldTools?: WorldToolRegistration
): void {
  const tools = selectTools(ovContext, worldTools);
  for (const tool of tools) {
    pi.registerTool(bindToolContext(tool, stateContext, ovContext));
  }
}

function selectTools(ovContext: OpenVikingToolContext | undefined, worldTools: WorldToolRegistration | undefined): ToolDefinition[] {
  if (worldTools === undefined) {
    return ovContext ? [...stateTools, ...memoryTools] : stateTools;
  }

  const selected: ToolDefinition[] = [];
  for (const groupName of worldTools.include ?? []) {
    if (groupName === "core.memory" && !ovContext) {
      continue;
    }
    const group = builtinToolGroups[groupName];
    if (group === undefined) {
      throw new Error(`Unknown world tool include "${groupName}". Known includes: ${Object.keys(builtinToolGroups).join(", ")}.`);
    }
    selected.push(...group);
  }
  selected.push(...loadWorldExtraTools(worldTools.extra ?? []));
  return uniqueToolsByName(selected);
}

function loadWorldExtraTools(paths: string[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const path of paths) {
    const module = requireToolModule(path) as Record<string, unknown>;
    const moduleTools = Object.values(module).filter(isToolDefinition);
    if (moduleTools.length === 0) {
      throw new Error(`World tool module exported no tools: ${path}`);
    }
    tools.push(...moduleTools);
  }
  return tools;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ToolDefinition>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.parameters === "object" &&
    candidate.parameters !== null &&
    typeof candidate.execute === "function"
  );
}

function uniqueToolsByName(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate registered tool name "${tool.name}".`);
    }
    seen.add(tool.name);
    return true;
  });
}

// The registry is the seam between the pi runtime and the domain. pi calls
// `execute(toolCallId, params, signal, onUpdate, ctx)` with the real
// ExtensionContext; we resolve the bound save from `ctx.sessionManager`,
// hydrate it, then hand the inner tool a *domain* context (db/stateStore/...)
// in the `ctx` slot. Tools stay decoupled from pi internals; session identity
// flows from the real contract instead of the invented getCurrentSessionId.
function bindToolContext(
  tool: ToolDefinition,
  stateContext?: StateToolContext,
  ovContext?: OpenVikingToolContext
): ToolDefinition {
  const labeled: ToolDefinition = tool.label ? tool : { ...tool, label: DEFAULT_TOOL_LABEL };

  if (labeled.name === "search_memory" || labeled.name === "read_memory") {
    if (!ovContext) {
      return labeled;
    }
    return {
      ...labeled,
      execute(toolCallId, params, signal, onUpdate, ctx) {
        hydrateBoundSave(ovContext, ctx);
        return tool.execute(toolCallId, params, signal, onUpdate, ovContext as unknown as ExtensionContextLike);
      }
    };
  }

  if (!stateContext) {
    return labeled;
  }

  return {
    ...labeled,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const piSessionId = resolveSessionId(ctx);
      hydrateBoundSave(stateContext, ctx);
      const domainContext: StateToolContext = piSessionId
        ? { ...stateContext, piSessionId }
        : stateContext;
      return tool.execute(toolCallId, params, signal, onUpdate, domainContext as unknown as ExtensionContextLike);
    }
  };
}

function hydrateBoundSave(
  context: Pick<StateToolContext, "db" | "stateStore" | "systemRuntime" | "storySnapshots" | "projectRoot"> | undefined,
  ctx: ExtensionContextLike | undefined
): void {
  if (!context) {
    return;
  }
  const piSessionId = resolveSessionId(ctx);
  if (!piSessionId) {
    return;
  }
  const saveId = getBoundSave(context.db, piSessionId);
  if (!saveId) {
    return;
  }
  // Hydrate + expose RP_ACTIVE_SAVE to child subagents (env inherited on spawn)
  // + project this save's GM-forged roles into .pi/agents/. Centralized in
  // activateSave so every save-bind entry point follows the same lifecycle.
  activateSave({
    projectRoot: context.projectRoot,
    db: context.db,
    stateStore: context.stateStore,
    systemRuntime: context.systemRuntime,
    storySnapshots: context.storySnapshots,
    saveId
  });
}
