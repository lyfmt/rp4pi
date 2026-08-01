import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { filterGmContextMessages } from "../src/runtime/context-filter.ts";
import { getRuntimeInfrastructure } from "../src/runtime/bootstrap.ts";
import { findProjectRoot } from "../src/runtime/paths.ts";
import { type RuntimeMessage } from "../src/runtime/prose-message.ts";
import { fireHooks } from "../src/hooks/engine.ts";
import {
  activeHookPrompts,
  beginTurnPrompts,
  hookPromptMessage
} from "../src/hooks/pending-prompts.ts";
import { createHookDelivery, registerHookNoticeRenderer } from "../src/hooks/wiring.ts";
import { onTurnRendered } from "../src/runtime/turn-events.ts";
import { drainStoryCommits } from "../src/runtime/story-commit-tracker.ts";
import { emitLiveProgress } from "../src/runtime/live-progress.ts";
import { activateSave } from "../src/state/active-save.ts";
import { listDynamicRoles } from "../src/state/dynamic-roles.ts";
import { getBoundSave } from "../src/state/session-binding.ts";
import { registerAllTools } from "../src/tools/registry.ts";
import { registerAllCommands } from "../src/commands/registry.ts";
import { materializeWorldSubagents } from "../src/world/materialize-subagents.ts";
import { materializeDynamicRoles } from "../src/world/materialize-dynamic-roles.ts";
import type { LoadedWorld, PromptTemplateSpec } from "../src/world/schema.ts";
import { resolveSessionId, type PiLike } from "../src/types/pi.ts";

// Core extension: the always-on backbone every game session needs. It owns the
// shared infrastructure (db/stateStore/ovClient via the memoized bootstrap),
// surfaces skills + GM prompts, keeps injected prose out of the GM's context,
// and registers the state tools + slash commands. The two Pass-B concerns
// (writer rendering, long-term memory) live in their own extensions loaded
// alongside this one via additional `-e` flags; they share this same
// infrastructure through the module-level singleton, not through this file.
//
// This is the single seam where invented adapters meet the real pi contract:
// `start.sh` runs `pi -e ./extensions/core.ts`, so the real ExtensionAPI is
// what activate() receives in production.

export type GmContextAssemblyInput = {
  promptTemplate?: PromptTemplateSpec;
  messages: readonly RuntimeMessage[];
  hookPrompts: readonly string[];
  log?: (message: string) => void;
};

export function gmPromptPathsForResources(world: Pick<LoadedWorld, "gmPromptPaths" | "promptTemplates">): string[] {
  return world.promptTemplates.gm === undefined ? world.gmPromptPaths : [];
}

/** Every skill under skills/ (a dir with a SKILL.md), sorted. Enumerated from
 * disk so this stays the same set `start.sh --skill ./skills/` loads — a
 * hardcoded list here silently drifted to 3 of 5 skills once already. */
export function listSkillPaths(projectRoot: string): string[] {
  const skillsDir = join(projectRoot, "skills");
  if (!existsSync(skillsDir)) {
    return [];
  }
  return readdirSync(skillsDir)
    .filter((entry) => existsSync(join(skillsDir, entry, "SKILL.md")))
    .sort()
    .map((entry) => join(skillsDir, entry));
}

export function assembleGmContextMessages(input: GmContextAssemblyInput): RuntimeMessage[] {
  const chatHistory = filterGmContextMessages(input.messages);
  const hookMessages = input.hookPrompts.map(hookPromptMessage);
  if (input.promptTemplate === undefined) {
    return [...chatHistory, ...hookMessages];
  }

  const messages: RuntimeMessage[] = [];
  let includesChatHistory = false;
  for (const entry of input.promptTemplate.entries) {
    if (entry.kind === "message") {
      messages.push({
        // The pi context seam does not expose a separate systemPrompt, and
        // mid-history system messages are not accepted uniformly across
        // providers. Literal GM system entries are therefore injected as user
        // guidance in the rebuilt context.
        role: entry.role === "system" ? "user" : entry.role,
        content: entry.content
      });
      continue;
    }

    if (entry.marker === "chat_history") {
      includesChatHistory = true;
      messages.push(...chatHistory);
      continue;
    }
    if (entry.marker === "hook_prompts") {
      messages.push(...hookMessages);
      continue;
    }
    throw new Error(`Unsupported GM prompt marker: ${entry.marker}`);
  }

  if (!includesChatHistory) {
    input.log?.("GM prompt template omitted chat_history; real conversation history will not be sent.");
  }
  return messages;
}

export function activate(pi: PiLike): void {
  const projectRoot = findProjectRoot(import.meta.url);
  const { db, stateStore, systemRegistry, systemRuntime, storySnapshots, ovClient, world } =
    getRuntimeInfrastructure(projectRoot);

  // Project this world's subagents into .pi/agents/ so pi-subagents can
  // discover them as project agents. Rewritten every startup so world.yaml /
  // agent.md edits take effect on the next run; the world pack stays the source
  // of truth. No-op (bar stale cleanup) for worlds that declare no subagents.
  materializeWorldSubagents(projectRoot, world);

  // Player-facing renderer for hook notices (inject `as: notice`). Registered
  // unconditionally; harmless when the world declares no notice-emitting hooks.
  registerHookNoticeRenderer(pi);

  // Sessions that have already fired their once-per-session `session_start`
  // hooks. Keyed by pi session id so a fresh session (new save / reload) fires
  // them again but a mid-session turn does not.
  const sessionStartFired = new Set<string>();

  // skills + prompts come back through resources_discover, not registerSkillPath.
  // GM prompts come from the active world pack, not a hardcoded path — this is
  // the seam that lets swapping worlds swap the GM persona.
  pi.on("resources_discover", () => ({
    skillPaths: listSkillPaths(projectRoot),
    // A GM prompt template owns the complete context assembly, including any
    // literal system guidance; the legacy gmPromptPaths system injection remains
    // only for worlds without a template.
    promptPaths: gmPromptPathsForResources(world)
  }));

  // Keep the GM's view of conversation history clean of our injected prose, then
  // splice in any active hook guidance (inject `as: prompt` / delegate) so the GM
  // weaves it into the turn it is about to run. The prompts are read, not drained,
  // so they persist across every model call within the turn; the turn boundary
  // (before_agent_start → beginTurnPrompts) expires them.
  pi.on("context", (event) => {
    return {
      messages: assembleGmContextMessages({
        promptTemplate: world.promptTemplates.gm,
        messages: event.messages as RuntimeMessage[],
        hookPrompts: activeHookPrompts(),
        log: (message) => console.error(`[prompt_template] ${message}`)
      })
    };
  });

  // Activate the bound save at the START of every turn — before the GM can call
  // any tool. This is what exposes RP_ACTIVE_SAVE to child subagents: previously
  // it was only set as a side effect of a state tool's hydrate, so a turn whose
  // first action is `subagent` (delegating a role/forge with no prior state
  // tool) spawned a child with RP_ACTIVE_SAVE unset — the child's recall_self /
  // remember_action then failed with "no-active-save". Doing it here decouples
  // the env from tool-call ordering and also re-projects the save's forged roles.
  pi.on("before_agent_start", (_event, ctx) => {
    const piSessionId = resolveSessionId(ctx);
    if (!piSessionId) {
      return;
    }
    const saveId = getBoundSave(db, piSessionId);
    if (!saveId) {
      return;
    }
    activateSave({ projectRoot, db, stateStore, systemRuntime, storySnapshots, saveId });

    if (world.hooks.length === 0) {
      return;
    }
    // Rotate the hook-prompt buckets at the turn boundary: this turn's expiring
    // guidance is dropped and the previous turn's `turn_committed` guidance
    // (pending) becomes active. Then fire the pre-turn anchors, whose prompts
    // land in this now-active bucket — `session_start` once per session, then
    // `turn_start` every turn.
    beginTurnPrompts();
    const delivery = createHookDelivery({ ctx, sendMessage: (m, o) => pi.sendMessage(m, o), target: "active" });
    const deps = { db, stateStore, delivery, log: (message: string) => console.error(`[hooks] ${message}`) };
    if (!sessionStartFired.has(piSessionId)) {
      sessionStartFired.add(piSessionId);
      fireHooks({ hooks: world.hooks, anchor: "session_start", saveId, deps });
    }
    fireHooks({ hooks: world.hooks, anchor: "turn_start", saveId, deps });
  });

  // `turn_committed`: after a turn's prose is rendered and committed, the
  // two-pass-render extension broadcasts it over the in-process turn-events bus.
  // We subscribe here (rather than on pi's agent_end) for the same reason the OV
  // memory extension does — the committed saveId is handed across that seam. Its
  // hooks' prompts target the NEXT turn (`pending`); state mutations write the
  // post-turn drift that becomes next turn's starting point. Fire-state is NOT
  // rolled back by /roll, so cadence does not re-fire on undo.
  const unsubscribeTurnCommittedHooks = onTurnRendered(async ({ ctx, saveId, progress }) => {
    if (world.hooks.length === 0) {
      return;
    }
    await emitLiveProgress(progress, { type: "stage_start", stage: "hook", detail: "turn_committed" });
    const delivery = createHookDelivery({ ctx, sendMessage: (m, o) => pi.sendMessage(m, o), target: "pending" });
    const deps = { db, stateStore, delivery, log: (message: string) => console.error(`[hooks] ${message}`) };
    try {
      fireHooks({ hooks: world.hooks, anchor: "turn_committed", saveId, deps });
      await emitLiveProgress(progress, { type: "stage_end", stage: "hook", detail: "turn_committed" });
    } catch (error) {
      await emitLiveProgress(progress, { type: "stage_error", stage: "hook", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  pi.on("session_shutdown", async () => {
    // In-flight story commits still need this listener (turn_committed hook
    // drift fires through the turn-rendered bus) — drain them BEFORE
    // unsubscribing. core's shutdown handler runs first (activation order), so
    // skipping the drain here would drop the hooks of the final turn in
    // single-shot runs (`pi -p`) and on quit/session switch.
    await drainStoryCommits();
    unsubscribeTurnCommittedHooks();
  });

  // The world's initial values + attribute specs flow into the state tools so
  // initialize_new_game seeds this world's defaults and update_attribute
  // validates against this world's declared attributes.
  const stateContext = {
    db,
    stateStore,
    systemRegistry,
    systemRuntime,
    storySnapshots,
    initialState: world.initialState,
    attributeSpecs: world.attributes,
    worldName: world.name,
    projectRoot
  };
  registerAllTools(pi, stateContext, ovClient ? { db, stateStore, ovClient } : undefined, world.tools);
  registerAllCommands(pi, {
    db,
    stateStore,
    systemRuntime,
    storySnapshots,
    projectRoot,
    getSubagents: (piSessionId) => {
      const staticSubagents = world.subagents.map(({ name, model, thinking }) => ({ name, model, thinking }));
      const saveId = getBoundSave(db, piSessionId);
      const dynamicSubagents = saveId === undefined
        ? []
        : listDynamicRoles(db, saveId).map(({ name }) => ({ name }));
      return [...staticSubagents, ...dynamicSubagents];
    },
    onSubagentsChanged: (piSessionId) => {
      materializeWorldSubagents(projectRoot, world);
      const saveId = getBoundSave(db, piSessionId);
      if (saveId !== undefined) {
        materializeDynamicRoles(projectRoot, db, saveId);
      }
    }
  });
}

export default activate;
