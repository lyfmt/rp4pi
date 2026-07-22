import type { RpDatabase } from "../state/sqlite.ts";
import type { OpenVikingClient, OpenVikingMemoryPolicy } from "./client.ts";
import { getOrCreateOvSessionForSave, replaceOvSessionForSave } from "./session-binding.ts";
import { userSpaceForSave } from "./uri.ts";

export type AppendTurnToMemoryInput = {
  db: RpDatabase;
  saveId: string;
  playerInput: string;
  writerProse: string;
  client: OpenVikingClient;
  /** Primary memory policy — supplied by the active world (memory.policy). */
  memoryPolicy: OpenVikingMemoryPolicy;
  /** Fallback policy used when OV has not loaded the world's custom schemas. */
  fallbackMemoryPolicy: OpenVikingMemoryPolicy;
};

export async function appendTurnToMemory(input: AppendTurnToMemoryInput): Promise<void> {
  const sessionId = getOrCreateOvSessionForSave(input.db, input.saveId);
  const saveClient = input.client.forUser(userSpaceForSave(input.saveId));
  try {
    await appendTurnToSession(saveClient, sessionId, input, input.memoryPolicy);
  } catch (error) {
    if (!isUnknownMemoryTypesError(error)) {
      throw error;
    }
    const fallbackSessionId = replaceOvSessionForSave(input.db, input.saveId);
    await appendTurnToSession(saveClient, fallbackSessionId, input, input.fallbackMemoryPolicy);
  }
}

async function appendTurnToSession(
  client: OpenVikingClient,
  sessionId: string,
  input: AppendTurnToMemoryInput,
  memoryPolicy: OpenVikingMemoryPolicy
): Promise<void> {
  await client.ensureSession(sessionId, { memoryPolicy });
  await client.addSessionMessage(sessionId, "user", input.playerInput);
  await client.addSessionMessage(sessionId, "assistant", input.writerProse);
  await client.commitSession(sessionId, { keepRecentCount: 0 });
}

function isUnknownMemoryTypesError(error: unknown): boolean {
  return error instanceof Error && /Unknown memory_policy\.memory_types/.test(error.message);
}
