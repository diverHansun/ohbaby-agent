import type { BusInstance } from "../../bus/index.js";
import { createMessage } from "./factory.js";
import { createMessageIdGenerator } from "./id-generator.js";
import { MessageEvent } from "./events.js";
import { toModelMessages as convertToModelMessages } from "./converter.js";
import type {
  CreateMessageInput,
  CreatePartInput,
  Message,
  MessageIdGenerator,
  MessageManager,
  MessageStore,
  MessageWithParts,
  Part,
  UpdateMessagePatch,
  UpdatePartPatch,
} from "./types.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";

export interface MessageManagerOptions {
  readonly bus: BusInstance;
  readonly store: MessageStore;
  readonly idGenerator?: MessageIdGenerator;
  readonly now?: () => number;
}

export function createMessageManager(
  options: MessageManagerOptions,
): MessageManager {
  const idGenerator = options.idGenerator ?? createMessageIdGenerator();
  const now = options.now ?? Date.now;

  async function createMessageRecord(
    input: CreateMessageInput,
  ): Promise<Message> {
    const message = createMessage({ data: input, idGenerator, now });
    await options.store.insertMessage(message);
    options.bus.publish(MessageEvent.Updated, { info: message });
    return message;
  }

  async function appendPart(
    messageId: string,
    input: CreatePartInput,
  ): Promise<Part> {
    const message = await getExistingMessage(messageId);
    const part = await options.store.appendPart({
      message,
      partId: idGenerator.partId(),
      data: input,
      updatedAt: now(),
    });
    options.bus.publish(MessageEvent.PartUpdated, { part });
    return part;
  }

  async function updatePart(
    partId: string,
    patch: UpdatePartPatch,
  ): Promise<Part> {
    const { delta, ...storePatch } = patch;
    const part = await options.store.updatePart(partId, storePatch, now());
    const payload = delta === undefined ? { part } : { part, delta };
    options.bus.publish(MessageEvent.PartUpdated, payload);
    return part;
  }

  async function getExistingMessage(messageId: string): Promise<Message> {
    const message = await options.store.getMessage(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    return message;
  }

  return {
    createMessage: createMessageRecord,

    async updateMessage(
      messageId: string,
      patch: UpdateMessagePatch,
    ): Promise<Message> {
      const message = await options.store.updateMessage(messageId, patch);
      options.bus.publish(MessageEvent.Updated, { info: message });
      return message;
    },

    appendPart,
    updatePart,

    listBySession(sessionId: string): Promise<MessageWithParts[]> {
      return options.store.listBySession(sessionId);
    },

    async removeMessage(messageId: string): Promise<void> {
      const message = await getExistingMessage(messageId);
      await options.store.deleteMessage(messageId);
      options.bus.publish(MessageEvent.Removed, {
        sessionId: message.sessionId,
        messageId,
      });
    },

    async removeMessages(sessionId: string): Promise<void> {
      const messages = await options.store.listBySession(sessionId);
      await options.store.deleteBySession(sessionId);
      for (const message of messages) {
        options.bus.publish(MessageEvent.Removed, {
          sessionId,
          messageId: message.info.id,
        });
      }
    },

    async toModelMessages(sessionId: string): Promise<ChatCompletionMessage[]> {
      return convertToModelMessages(
        await options.store.listBySession(sessionId),
      );
    },
  };
}
