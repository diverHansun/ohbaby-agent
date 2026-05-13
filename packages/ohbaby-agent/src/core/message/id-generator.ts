import type { MessageIdGenerator } from "./types.js";

export function createMessageIdGenerator(): MessageIdGenerator {
  return {
    messageId(): string {
      return createId("message");
    },
    partId(): string {
      return createId("part");
    },
  };
}

function createId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${String(timestamp)}_${random}`;
}
