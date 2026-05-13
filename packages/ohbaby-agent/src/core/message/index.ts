import { MessageEvent } from "./events.js";

export { MessageEvent } from "./events.js";
export { createMessageManager } from "./manager.js";
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
  ReasoningPart,
  SystemMessage,
  TextPart,
  ToolPart,
  ToolState,
  UpdateMessagePatch,
  UpdatePartPatch,
  UserMessage,
} from "./types.js";

export const Message: { readonly Event: typeof MessageEvent } = {
  Event: MessageEvent,
};
