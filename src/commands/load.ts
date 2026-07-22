import { activateSave } from "../state/active-save.ts";
import { bindSessionToSave } from "../state/session-binding.ts";
import { formatStatus } from "../state/status.ts";
import { listSaves } from "../state/save-repository.ts";
import type { CommandDefinition } from "./context.ts";
import { isValidPickSaveOptions, pickSave, renderSavePickerPage } from "./picker.ts";

export const loadCommand: CommandDefinition = {
  name: "load",
  description: "Load a save for the current PI session.",
  async execute(input, context) {
    const saves = listSaves(context.db);
    const options = parseLoadInput(input);
    if (!isValidPickSaveOptions(options)) {
      return "存档选择无效。";
    }
    if (!context.nativePickSave && options.selectNumber === undefined) {
      return renderSavePickerPage(saves, options.page ?? 0);
    }

    const selected = await pickSave(saves, { ...options, nativePickSave: context.nativePickSave });
    if (!selected) {
      return "未选择存档。";
    }

    // Hydrate + expose RP_ACTIVE_SAVE + project this save's forged roles into
    // .pi/agents/ (so a save loaded in a fresh process regains its GM-forged
    // cast, and another save's roles are cleared).
    activateSave({
      projectRoot: context.projectRoot,
      db: context.db,
      stateStore: context.stateStore,
      systemRuntime: context.systemRuntime,
      storySnapshots: context.storySnapshots,
      saveId: selected.id
    });
    bindSessionToSave(context.db, context.piSessionId, selected.id);
    return formatStatus(context.stateStore.getState());
  }
};

function parseLoadInput(input: unknown): { page?: number; selectNumber?: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }
  const record = input as Record<string, unknown>;
  return {
    page: typeof record.page === "number" ? record.page : undefined,
    selectNumber: typeof record.selectNumber === "number" ? record.selectNumber : undefined
  };
}
