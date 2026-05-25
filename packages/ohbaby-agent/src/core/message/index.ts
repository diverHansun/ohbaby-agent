import { MessageEvent } from "./events.js";

export { MessageEvent } from "./events.js";
export { createMessageManager } from "./manager.js";
export { createDatabaseMessageStore } from "./database-store.js";
export { createInMemoryMessageStore } from "./store.js";
export { toModelMessages } from "./converter.js";
export type {
  AssistantMessage,
  CreateMessageInput,
  CreatePartInput,
  Message as CoreMessage,
  MessageError,
  MessageIdGenerator,
  MessageManager,
  MessageRole,
  MessageStore,
  MessageTime,
  MessageWithParts,
  Part,
  PartBase,
  PartMetadata,
  PartTime,
  ReasoningPart,
  SystemMessage,
  TextPart,
  TokenUsageMetadata,
  ToolPart,
  ToolState,
  UpdateMessagePatch,
  UpdatePartPatch,
  UserMessage,
} from "./types.js";

export const Message: { readonly Event: typeof MessageEvent } = {
  Event: MessageEvent,
};
