import type { RpDatabase } from "../state/sqlite.ts";
import type { OpenVikingClient, OpenVikingCommitResult, OpenVikingMemoryPolicy } from "./client.ts";
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

export type AppendTurnToMemoryResult = {
  /** Save-scoped client the append ran against — the task watch must reuse it. */
  saveClient: OpenVikingClient;
  /** Background extraction task id, when the server commits asynchronously. */
  taskId?: string;
};

export async function appendTurnToMemory(input: AppendTurnToMemoryInput): Promise<AppendTurnToMemoryResult> {
  const sessionId = getOrCreateOvSessionForSave(input.db, input.saveId);
  const saveClient = input.client.forUser(userSpaceForSave(input.saveId));
  let commit: OpenVikingCommitResult;
  try {
    commit = await appendTurnToSession(saveClient, sessionId, input, input.memoryPolicy);
  } catch (error) {
    if (!isUnknownMemoryTypesError(error)) {
      throw error;
    }
    const fallbackSessionId = replaceOvSessionForSave(input.db, input.saveId);
    commit = await appendTurnToSession(saveClient, fallbackSessionId, input, input.fallbackMemoryPolicy);
  }
  return { saveClient, taskId: commit.taskId };
}

async function appendTurnToSession(
  client: OpenVikingClient,
  sessionId: string,
  input: AppendTurnToMemoryInput,
  memoryPolicy: OpenVikingMemoryPolicy
): Promise<OpenVikingCommitResult> {
  await client.ensureSession(sessionId, { memoryPolicy });
  await client.addSessionMessage(sessionId, "user", input.playerInput);
  await client.addSessionMessage(sessionId, "assistant", input.writerProse);
  return client.commitSession(sessionId, { keepRecentCount: 0 });
}

function isUnknownMemoryTypesError(error: unknown): boolean {
  return error instanceof Error && /Unknown memory_policy\.memory_types/.test(error.message);
}
