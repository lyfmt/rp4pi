import { join } from "node:path";
import { filterGmContextMessages } from "./src/runtime/context-filter.ts";
import { loadRuntimeConfig } from "./src/runtime/config.ts";
import { createAgentEndHandler } from "./src/runtime/turn-hook.ts";
import { type RuntimeMessage } from "./src/runtime/prose-message.ts";
import { resolveProjectRoot } from "./src/runtime/paths.ts";
import { createConfiguredWriterClient } from "./src/runtime/writer-client.ts";
import { appendTurnToMemory } from "./src/ov/turn-memory-hook.ts";
import { createOpenVikingClient } from "./src/ov/client.ts";
import { readOpenVikingConfig } from "./src/ov/config.ts";
import { initializeSchema, openRpDatabase } from "./src/state/sqlite.ts";
import { createStateStore } from "./src/state/store.ts";
import { registerAllTools } from "./src/tools/registry.ts";
import { registerAllCommands } from "./src/commands/registry.ts";
import type { ExtensionContextLike, PiLike } from "./src/types/pi.ts";
import type { WriterClient } from "./src/runtime/writer-client.ts";

// Real pi hooks are registered with pi.on(event, handler). The pre-fix
// scaffold called registerHook/registerSkillPath — which do not exist on the
// real ExtensionAPI — so the entire runtime silently no-op'd. This file is the
// single seam where invented adapters meet the real pi contract; everything
// left of here is domain, everything right is pi.
export function activate(pi: PiLike, services: RuntimeServices = {}): void {
  const projectRoot = resolveProjectRoot(import.meta.url);
  const config = loadRuntimeConfig(projectRoot);
  const db = openRpDatabase(config.sqlitePath);
  initializeSchema(db);
  const stateStore = createStateStore(db);
  const ovClient = createConfiguredOpenVikingClient(projectRoot);
  registerMessageRenderers(pi);

  // skills + prompts come back through resources_discover, not registerSkillPath.
  pi.on("resources_discover", () => ({
    skillPaths: [
      join(projectRoot, "skills", "start-game"),
      join(projectRoot, "skills", "development-guide")
    ],
    promptPaths: [
      join(projectRoot, "agents", "gm-core.md"),
      join(projectRoot, "agents", "gm-tools.md"),
      join(projectRoot, "agents", "gm-output.md")
    ]
  }));

  // Keep the GM's view of conversation history clean of our injected prose.
  pi.on("context", (event) => ({
    messages: filterGmContextMessages(event.messages as RuntimeMessage[])
  }));

  registerAllTools(pi, { db, stateStore }, ovClient ? { db, stateStore, ovClient } : undefined);
  registerAllCommands(pi, { db, stateStore });

  // Two-pass commit: when the GM loop ends (submit_direction_packet terminated
  // it), render via the writer and deliver the prose as a custom message — but
  // only once the agent is idle, so the injected message does not re-trigger the
  // loop. Rendering on `agent_end` (not the mid-loop `tool_result`) is what stops
  // the GM from continuing to work after the writer output.
  pi.on("agent_end", createAgentEndHandler({
    db,
    stateStore,
    createWriterClient: (ctx) =>
      services.createWriterClient?.(ctx) ?? createConfiguredWriterClient({ projectRoot, ctx }),
    sendMessage: (message, options) => pi.sendMessage(message, options),
    appendTurnToMemory: ovClient
      ? (memoryInput) => appendTurnToMemory({ db, client: ovClient, ...memoryInput })
      : undefined
  }));
}

export default activate;

type RuntimeServices = {
  createWriterClient?: (ctx: ExtensionContextLike) => WriterClient;
};

function registerMessageRenderers(pi: PiLike): void {
  pi.registerMessageRenderer?.("openviking-memory-error", (message) => {
    const details = readDetails(message);
    return {
      type: "text",
      text: [
        "⚠ OpenViking memory append failed",
        `save: ${readString(details.saveId)}`,
        `reason: ${readString(details.error) || readString((message as { content?: unknown }).content)}`
      ].join("\n")
    };
  });
}

function readDetails(message: unknown): Record<string, unknown> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return {};
  }
  const details = (message as { details?: unknown }).details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function createConfiguredOpenVikingClient(projectRoot: string) {
  try {
    const config = readOpenVikingConfig(process.env, projectRoot);
    return createOpenVikingClient({ ...config, user: "rp-agent" });
  } catch {
    return undefined;
  }
}

// satisfy the resolveSessionId import surface used by consumers that import
// extension types transitively
export type { ExtensionContextLike };
