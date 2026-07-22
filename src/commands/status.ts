import { formatStatus } from "../state/status.ts";
import { formatSystemProjections } from "../systems/status.ts";
import type { CommandDefinition } from "./context.ts";
import { requireSessionSave } from "./context.ts";

export const statusCommand: CommandDefinition = {
  name: "status",
  description: "Show current RP status.",
  execute(_input, context) {
    const saveId = requireSessionSave(context);
    const coreStatus = formatStatus(context.stateStore.getState());
    if (!context.systemRuntime) {
      return coreStatus;
    }
    return context.systemRuntime
      .project({ saveId, audience: { kind: "gm" } })
      .then((projections) =>
        projections.length === 0
          ? coreStatus
          : `${coreStatus}\n\n${formatSystemProjections(projections)}`
      );
  }
};
