import { isWriterProseMessage, type RuntimeMessage } from "./prose-message.ts";

export function filterGmContextMessages<T extends RuntimeMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isWriterProseMessage(message));
}
