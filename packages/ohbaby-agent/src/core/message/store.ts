import type {
  Message,
  MessageStore,
  MessageWithParts,
  MessageScopeFilter,
  Part,
  CreatePartInput,
  UpdateMessagePatch,
  UpdatePartPatch,
} from "./types.js";

export function createInMemoryMessageStore(): MessageStore {
  const messages = new Map<string, Message>();
  const parts = new Map<string, Part>();

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function listPartsForMessage(messageId: string): Part[] {
    return Array.from(parts.values())
      .filter((part) => part.messageId === messageId)
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map(clone);
  }

  function touchMessage(messageId: string, updatedAt: number): void {
    const message = messages.get(messageId);
    if (!message) {
      return;
    }
    messages.set(messageId, {
      ...message,
      time: {
        ...message.time,
        updated: updatedAt,
      },
    });
  }

  function createPart(input: {
    readonly message: Message;
    readonly partId: string;
    readonly data: CreatePartInput;
  }): Part {
    const orderIndex = Array.from(parts.values()).filter(
      (part) => part.messageId === input.message.id,
    ).length;

    return {
      contextScopeId: input.message.contextScopeId,
      id: input.partId,
      messageId: input.message.id,
      sessionId: input.message.sessionId,
      orderIndex,
      ...input.data,
    };
  }

  return {
    insertMessage(message: Message): Promise<void> {
      if (messages.has(message.id)) {
        return Promise.reject(
          new Error(`Message already exists: ${message.id}`),
        );
      }
      messages.set(message.id, clone(message));
      return Promise.resolve();
    },

    getMessage(messageId: string): Promise<Message | undefined> {
      const message = messages.get(messageId);
      return Promise.resolve(message ? clone(message) : undefined);
    },

    updateMessage(
      messageId: string,
      patch: UpdateMessagePatch,
    ): Promise<Message> {
      const existing = messages.get(messageId);
      if (!existing) {
        return Promise.reject(new Error(`Message not found: ${messageId}`));
      }
      const updated = { ...existing, ...patch } as Message;
      messages.set(messageId, clone(updated));
      return Promise.resolve(clone(updated));
    },

    appendPart(input: {
      readonly message: Message;
      readonly partId: string;
      readonly data: CreatePartInput;
      readonly updatedAt: number;
    }): Promise<Part> {
      if (!messages.has(input.message.id)) {
        return Promise.reject(
          new Error(`Message not found: ${input.message.id}`),
        );
      }
      const part = createPart(input);
      parts.set(part.id, clone(part));
      touchMessage(input.message.id, input.updatedAt);
      return Promise.resolve(clone(part));
    },

    updatePart(
      partId: string,
      patch: Omit<UpdatePartPatch, "delta">,
      updatedAt: number,
    ): Promise<Part> {
      const existing = parts.get(partId);
      if (!existing) {
        return Promise.reject(new Error(`Part not found: ${partId}`));
      }
      const updated = { ...existing, ...patch } as Part;
      parts.set(partId, clone(updated));
      touchMessage(existing.messageId, updatedAt);
      return Promise.resolve(clone(updated));
    },

    listBySession(
      sessionId: string,
      options?: MessageScopeFilter,
    ): Promise<MessageWithParts[]> {
      const sessionMessages = Array.from(messages.values())
        .filter((message) => message.sessionId === sessionId)
        .filter(
          (message) =>
            options?.contextScopeId === undefined ||
            message.contextScopeId === options.contextScopeId,
        )
        .sort((left, right) => left.time.created - right.time.created);

      return Promise.resolve(
        sessionMessages.map((message) => ({
          info: clone(message),
          parts: listPartsForMessage(message.id),
        })),
      );
    },

    deleteMessage(messageId: string): Promise<void> {
      const message = messages.get(messageId);
      if (!message) {
        return Promise.resolve();
      }
      messages.delete(messageId);
      for (const [partId, part] of parts.entries()) {
        if (part.messageId === messageId) {
          parts.delete(partId);
        }
      }
      return Promise.resolve();
    },

    deleteBySession(sessionId: string): Promise<void> {
      for (const [messageId, message] of messages.entries()) {
        if (message.sessionId === sessionId) {
          messages.delete(messageId);
        }
      }
      for (const [partId, part] of parts.entries()) {
        if (part.sessionId === sessionId) {
          parts.delete(partId);
        }
      }
      return Promise.resolve();
    },
  };
}
