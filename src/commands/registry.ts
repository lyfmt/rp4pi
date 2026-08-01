import { latestPlayerInput } from "../runtime/session-entries.ts";
import { resolveSessionId, type ExtensionCommandContextLike, type PiLike } from "../types/pi.ts";
import type { CommandContext, CommandDefinition } from "./context.ts";
import { loadCommand } from "./load.ts";
import { rollCommand } from "./roll.ts";
import { saveCommand } from "./save.ts";
import { createSavePickerComponent } from "./save-picker-component.ts";
import {
  registerRpConfigCommand,
  type RpConfigRegistrationContext
} from "./rpconfig.ts";
import { statusCommand } from "./status.ts";

const commands: CommandDefinition[] = [statusCommand, saveCommand, loadCommand, rollCommand];

export type CommandBaseContext = Omit<CommandContext, "piSessionId" | "nativePickSave" | "getLatestUserMessage" | "rerunTurn"> & {
  projectRoot?: string;
  getSubagents?: RpConfigRegistrationContext["getSubagents"];
  onSubagentsChanged?: RpConfigRegistrationContext["onSubagentsChanged"];
};

export function registerAllCommands(pi: PiLike, context: CommandBaseContext): void {
  for (const command of commands) {
    pi.registerCommand(command.name, {
      description: command.description,
      async handler(args, ctx) {
        const piSessionId = resolveSessionId(ctx);
        if (!piSessionId) {
          notify(ctx, "没有当前会话，无法执行命令。", "error");
          return;
        }

        const parsed = parseArgs(args);
        try {
          const output = await command.execute(parsed, {
            ...context,
            piSessionId,
            nativePickSave: pickSaveFactory(ctx),
            getLatestUserMessage: () => latestPlayerInput(readEntries(ctx)) ?? null,
            rerunTurn: resolveRerunTurn(ctx)
          });
          if (typeof output === "string" && output.length > 0) {
            notify(ctx, output, "info");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, message, "error");
        }
      }
    });
  }
  registerRpConfigCommand(pi, context);
}

// `record<string, unknown>` is the common case for our commands (none currently
// take positional args); keep generous so future arg parsing is local.
function parseArgs(args: string): unknown {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function pickSaveFactory(ctx: ExtensionCommandContextLike): CommandContext["nativePickSave"] {
  return (items) => {
    // Prefer the scrollable/filterable/paged custom selector in the TUI; fall
    // back to the built-in select dialog elsewhere (e.g. RPC mode).
    if (ctx.mode === "tui" && ctx.ui?.custom) {
      return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
        createSavePickerComponent(items, tui, theme, keybindings, done)
      );
    }
    if (!ctx.ui?.select) {
      return undefined;
    }
    const labels = items.map((item) => item.label);
    const picked = ctx.ui.select("选择存档", labels);
    if (picked instanceof Promise) {
      return picked.then((label) => items.find((item) => item.label === label)?.id);
    }
    return items.find((item) => item.label === picked)?.id;
  };
}

function readEntries(ctx: ExtensionCommandContextLike): unknown[] {
  const entries = ctx.sessionManager?.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}

function resolveRerunTurn(ctx: ExtensionCommandContextLike): CommandContext["rerunTurn"] {
  return typeof ctx.rerunTurn === "function" ? (message) => ctx.rerunTurn?.(message) : undefined;
}

function notify(ctx: ExtensionCommandContextLike, message: string, level: "info" | "warning" | "error"): void {
  ctx.ui?.notify?.(message, level);
}
