import { touchSave } from "../state/save-repository.ts";
import type { CommandDefinition } from "./context.ts";
import { requireActiveSaveId } from "./context.ts";

export const saveCommand: CommandDefinition = {
  name: "save",
  description: "Touch and report the current save id.",
  execute(_input, context) {
    const saveId = requireActiveSaveId(context);
    touchSave(context.db, saveId);
    return saveId;
  }
};
