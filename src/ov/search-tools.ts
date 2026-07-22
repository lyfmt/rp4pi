import type { StateStore } from "../state/store.ts";
import type { RpDatabase } from "../state/sqlite.ts";
import type { OpenVikingClient } from "./client.ts";

export type OpenVikingToolContext = {
  db: RpDatabase;
  stateStore: StateStore;
  ovClient: Pick<OpenVikingClient, "forUser" | "find" | "read">;
};

export function requireOpenVikingToolContext(context: unknown): OpenVikingToolContext {
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new TypeError("OpenViking tool context is required");
  }

  const candidate = context as Partial<OpenVikingToolContext>;
  if (
    !candidate.db ||
    !candidate.stateStore ||
    !candidate.ovClient ||
    typeof candidate.stateStore.getActiveSaveId !== "function" ||
    typeof candidate.ovClient.forUser !== "function" ||
    typeof candidate.ovClient.find !== "function" ||
    typeof candidate.ovClient.read !== "function"
  ) {
    throw new TypeError("Invalid OpenViking tool context");
  }

  return candidate as OpenVikingToolContext;
}

export function getActiveSaveIdForMemory(context: OpenVikingToolContext): string {
  const saveId = context.stateStore.getActiveSaveId();
  if (!saveId) {
    throw new Error("No active save for OpenViking memory lookup");
  }
  return saveId;
}
