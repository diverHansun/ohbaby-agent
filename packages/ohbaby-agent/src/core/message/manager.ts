import type { BusInstance } from "../../bus/index.js";
import { createMessage } from "./factory.js";
import { createMessageIdGenerator } from "./id-generator.js";
import { MessageEvent } from "./events.js";
import { toModelMessages as convertToModelMessages } from "./converter.js";
import type {
  CreateMessageInput,
  CreatePartInput,
  CommitCompactionInput,
  CommitCompactionResult,
  Message,
  MessageIdGenerator,
  MessageManager,
  MessageScopeFilter,
  MessageStore,
  MessageWithParts,
  Part,
  TextPart,
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
  const allocatedMessageIds = new Set<string>();

  function allocateMessageRecord(input: CreateMessageInput): Message {
    let message = createMessage({ data: input, idGenerator, now });
    while (input.id === undefined && allocatedMessageIds.has(message.id)) {
      message = createMessage({ data: input, idGenerator, now });
    }
    allocatedMessageIds.add(message.id);
    return message;
  }

  async function createMessageRecord(
    input: CreateMessageInput,
  ): Promise<Message> {
    const message = allocateMessageRecord(input);
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
    async appendModelContextPart(
      messageId: string,
      text: string,
    ): Promise<TextPart> {
      const result = await options.store.appendModelContextPart({
        messageId,
        partId: idGenerator.partId(),
        text,
        updatedAt: now(),
      });
      if (result.inserted) {
        options.bus.publish(MessageEvent.PartUpdated, { part: result.part });
      }
      return result.part;
    },
    updatePart,

    async commitCompaction(
      input: CommitCompactionInput,
    ): Promise<CommitCompactionResult> {
      const summaryMessage =
        input.summary === undefined
          ? undefined
          : allocateMessageRecord({
              agent: input.summary.agent,
              ...(input.contextScopeId === undefined
                ? {}
                : { contextScopeId: input.contextScopeId }),
              role: "assistant",
              sessionId: input.sessionId,
            });
      if (summaryMessage !== undefined && summaryMessage.role !== "assistant") {
        throw new Error("Compaction summary must be an assistant message");
      }
      const result = await options.store.commitCompaction({
        compactedAt: input.compactedAt,
        compactedPartIds: input.compactedPartIds,
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
        sessionId: input.sessionId,
        ...(input.summary === undefined || summaryMessage === undefined
          ? {}
          : {
              summary: {
                data: {
                  metadata: { kind: "context-summary" },
                  synthetic: true,
                  text: input.summary.text,
                  type: "text",
                },
                message: summaryMessage,
                partId: idGenerator.partId(),
              },
            }),
        updatedAt: now(),
      });
      if (result.summary !== undefined) {
        options.bus.publish(MessageEvent.Updated, {
          info: result.summary.message,
        });
        options.bus.publish(MessageEvent.PartUpdated, {
          part: result.summary.part,
        });
      }
      for (const part of result.updatedParts) {
        options.bus.publish(MessageEvent.PartUpdated, { part });
      }
      return result;
    },

    listBySession(
      sessionId: string,
      filter?: MessageScopeFilter,
    ): Promise<MessageWithParts[]> {
      return options.store.listBySession(sessionId, filter);
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

    async toModelMessages(
      sessionId: string,
      filter?: MessageScopeFilter,
    ): Promise<ChatCompletionMessage[]> {
      return convertToModelMessages(
        await options.store.listBySession(sessionId, filter),
      );
    },
  };
}
