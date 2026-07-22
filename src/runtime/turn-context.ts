import type { StateStore } from "../state/store.ts";
import type { RpDatabase } from "../state/sqlite.ts";
import type { RuntimeMessage } from "./prose-message.ts";
import type { WriterClient } from "./writer-client.ts";

export type TurnRuntimeContext = {
  db: RpDatabase;
  stateStore: StateStore;
  writerClient: WriterClient;
  writeCustomMessage: (message: RuntimeMessage) => void | Promise<void>;
};
