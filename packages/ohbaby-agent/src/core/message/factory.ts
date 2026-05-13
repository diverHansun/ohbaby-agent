import type {
  CreateMessageInput,
  CreatePartInput,
  Message,
  MessageIdGenerator,
  Part,
} from "./types.js";

export function createMessage(input: {
  readonly data: CreateMessageInput;
  readonly idGenerator: MessageIdGenerator;
  readonly now: () => number;
}): Message {
  const base = {
    id: input.idGenerator.messageId(),
    sessionId: input.data.sessionId,
    time: { created: input.now(), updated: input.now() },
  } as const;

  if (input.data.role === "user") {
    return {
      ...base,
      role: "user",
      agent: input.data.agent,
      model: input.data.model,
      system: input.data.system,
      tools: input.data.tools,
    };
  }

  if (input.data.role === "assistant") {
    return {
      ...base,
      role: "assistant",
      agent: input.data.agent,
      parentId: input.data.parentId,
      providerId: input.data.providerId,
      modelId: input.data.modelId,
    };
  }

  return {
    ...base,
    role: "system",
    kind: input.data.kind,
    agent: input.data.agent,
  };
}

export function createPart(input: {
  readonly data: CreatePartInput;
  readonly idGenerator: MessageIdGenerator;
  readonly message: Message;
  readonly orderIndex: number;
}): Part {
  const base = {
    id: input.idGenerator.partId(),
    messageId: input.message.id,
    sessionId: input.message.sessionId,
    orderIndex: input.orderIndex,
  } as const;

  return {
    ...base,
    ...input.data,
  };
}
