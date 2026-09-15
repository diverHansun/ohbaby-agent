import { isDeepStrictEqual } from "node:util";
import {
  ModelStateSchema,
  validateNativeProjection,
} from "../../services/interface-providers/native-state.js";
import { createTokenUsageMetadata } from "./token-usage-metadata.js";
import type {
  Message,
  ModelStatePart,
  ToolPart,
  StoreModelStepInput,
  CommitModelStepResult,
  MessageStore,
  MessageWithParts,
  MessageScopeFilter,
  Part,
  CreatePartInput,
  CommitCompactionResult,
  UpdateMessagePatch,
  UpdatePartPatch,
  StoreCompactionInput,
  TextPart,
} from "./types.js";
import { isModelContextPart, MODEL_CONTEXT_RUNTIME_KIND } from "./origin.js";

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
    commitModelStep(
      input: StoreModelStepInput,
    ): Promise<CommitModelStepResult> {
      const message = messages.get(input.assistantMessageId);
      const prepared = prepareModelStep(
        message,
        listPartsForMessage(input.assistantMessageId),
        input,
      );
      for (const part of prepared.insertedParts) {
        if (parts.has(part.id))
          throw new Error(`Part already exists: ${part.id}`);
      }
      // All validation and cloning happen before touching either map.
      const result = clone(prepared.result);
      for (const part of prepared.updatedParts) parts.set(part.id, part);
      for (const part of prepared.insertedParts) parts.set(part.id, part);
      messages.set(prepared.result.message.id, prepared.result.message);
      return Promise.resolve(result);
    },
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

    appendModelContextPart(input: {
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
      readonly updatedAt: number;
    }): Promise<{ readonly inserted: boolean; readonly part: TextPart }> {
      const message = messages.get(input.messageId);
      if (!message) {
        return Promise.reject(
          new Error(`Message not found: ${input.messageId}`),
        );
      }
      const existing = listPartsForMessage(input.messageId).find(
        isModelContextPart,
      );
      if (existing?.type === "text") {
        return Promise.resolve({ inserted: false, part: existing });
      }
      const part: TextPart = {
        contextScopeId: message.contextScopeId,
        id: input.partId,
        messageId: input.messageId,
        metadata: { kind: MODEL_CONTEXT_RUNTIME_KIND },
        orderIndex: listPartsForMessage(input.messageId).length,
        sessionId: message.sessionId,
        synthetic: true,
        text: input.text,
        type: "text",
      };
      parts.set(part.id, clone(part));
      touchMessage(input.messageId, input.updatedAt);
      return Promise.resolve({ inserted: true, part: clone(part) });
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

    commitCompaction(
      input: StoreCompactionInput,
    ): Promise<CommitCompactionResult | undefined> {
      const expectedPartIds = new Set(
        input.expectedParts.map((part) => part.id),
      );
      if (expectedPartIds.size !== input.expectedParts.length) {
        throw new Error("Compaction expected parts contain duplicate ids");
      }
      const targets: Part[] = [];
      for (const expectedPart of input.expectedParts) {
        if (
          expectedPart.sessionId !== input.sessionId ||
          expectedPart.contextScopeId !== input.contextScopeId
        ) {
          throw new Error(
            `Compaction part belongs to another scope: ${expectedPart.id}`,
          );
        }
        const part = parts.get(expectedPart.id);
        if (!part) {
          return Promise.resolve(undefined);
        }
        if (
          part.sessionId !== input.sessionId ||
          part.contextScopeId !== input.contextScopeId
        ) {
          throw new Error(
            `Compaction part belongs to another scope: ${expectedPart.id}`,
          );
        }
        if (
          part.time?.compacted !== undefined ||
          JSON.stringify(part) !== JSON.stringify(expectedPart)
        ) {
          return Promise.resolve(undefined);
        }
        targets.push(part);
      }
      if (input.summary !== undefined) {
        if (messages.has(input.summary.message.id)) {
          throw new Error(
            `Message already exists: ${input.summary.message.id}`,
          );
        }
        if (parts.has(input.summary.partId)) {
          throw new Error(`Part already exists: ${input.summary.partId}`);
        }
      }

      const summaryPart =
        input.summary === undefined
          ? undefined
          : (createPart({
              data: input.summary.data,
              message: input.summary.message,
              partId: input.summary.partId,
            }) as TextPart);
      if (input.summary !== undefined && summaryPart !== undefined) {
        messages.set(input.summary.message.id, clone(input.summary.message));
        parts.set(summaryPart.id, clone(summaryPart));
      }
      const updatedParts = targets.map((part) => {
        const updated = {
          ...part,
          time: { ...part.time, compacted: input.compactedAt },
        } as Part;
        parts.set(updated.id, clone(updated));
        touchMessage(updated.messageId, input.updatedAt);
        return clone(updated);
      });

      return Promise.resolve({
        ...(input.summary === undefined || summaryPart === undefined
          ? {}
          : {
              summary: {
                message: clone(input.summary.message),
                part: clone(summaryPart),
              },
            }),
        updatedParts,
      });
    },

    listBySession(
      sessionId: string,
      options?: MessageScopeFilter,
    ): Promise<MessageWithParts[]> {
      const sessionMessages = Array.from(messages.values())
        .filter((message) => message.sessionId === sessionId)
        .filter(
          (message) =>
            options === undefined ||
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

/** Shared preparation keeps both stores' validation and usage ownership identical. */
export function prepareModelStep(
  message: Message | undefined,
  existingParts: readonly Part[],
  input: StoreModelStepInput,
): {
  readonly result: CommitModelStepResult;
  readonly insertedParts: readonly Part[];
  readonly updatedParts: readonly Part[];
} {
  if (message?.role !== "assistant")
    throw new Error("Model step requires an existing assistant message");
  if (
    message.time.completed !== undefined ||
    existingParts.some(
      (part) => part.type === "model-state" || part.type === "tool",
    )
  )
    throw new Error("Assistant model step is already committed or completed");
  if (
    !Number.isFinite(input.completedAt) ||
    !["stop", "tool_calls", "content_filter"].includes(input.finishReason)
  )
    throw new Error("Cannot commit an incomplete model step");
  const modelState = ModelStateSchema.parse(input.modelState);
  if (
    modelState.origin.protocol !== modelState.output.protocol ||
    (message.providerId !== undefined &&
      message.providerId !== modelState.origin.provider) ||
    (message.modelId !== undefined &&
      message.modelId !== modelState.origin.model)
  )
    throw new Error("Model step source does not match its assistant message");
  if (
    modelState.output.protocol === "openai-responses" &&
    modelState.output.items.some(
      (item) => item.status !== undefined && item.status !== "completed",
    )
  )
    throw new Error("Cannot commit incomplete native items");
  const callIds = new Set(input.tools.map((tool) => tool.callId));
  if (callIds.size !== input.tools.length)
    throw new Error("Model step contains duplicate tool call ids");
  for (const tool of input.tools) {
    if (
      tool.callId.trim() === "" ||
      tool.name.trim() === "" ||
      !isDeepStrictEqual(JSON.parse(tool.argumentsJson), tool.arguments)
    )
      throw new Error(
        "Model step tool arguments do not match their raw projection",
      );
  }
  const selectedText =
    input.textPartId === undefined
      ? existingParts.find(
          (part) => part.type === "text" && !part.synthetic && !part.ignored,
        )
      : existingParts.find((part) => part.id === input.textPartId);
  if (selectedText !== undefined && selectedText.type !== "text")
    throw new Error("Model step text part is not text");
  if (input.textPartId !== undefined && selectedText === undefined)
    throw new Error("Model step text part does not belong to this assistant");
  if (
    existingParts.some(
      (part) =>
        part.type === "text" &&
        part.id !== selectedText?.id &&
        !part.synthetic &&
        !part.ignored &&
        part.text !== "",
    )
  )
    throw new Error("Model step has multiple visible text projections");
  const text = input.text ?? selectedText?.text ?? "";
  validateNativeProjection(
    {
      role: "assistant",
      content: text,
      toolCalls: input.tools.map((tool) => ({
        callId: tool.callId,
        name: tool.name,
        argumentsJson: tool.argumentsJson,
      })),
    },
    modelState.output,
  );
  if (input.toolPartIds.length !== input.tools.length)
    throw new Error("Model step tool part ids do not match tool calls");
  const ids = [
    input.statePartId,
    ...(selectedText === undefined && text !== "" ? [input.newTextPartId] : []),
    ...input.toolPartIds,
  ];
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => existingParts.some((part) => part.id === id))
  )
    throw new Error("Model step contains duplicate part ids");
  let nextOrder = existingParts.reduce(
    (next, part) => Math.max(next, part.orderIndex + 1),
    0,
  );
  const base = {
    messageId: message.id,
    sessionId: message.sessionId,
    ...(message.contextScopeId === undefined
      ? {}
      : { contextScopeId: message.contextScopeId }),
  };
  const textPart: TextPart | undefined =
    selectedText === undefined
      ? text === ""
        ? undefined
        : {
            ...base,
            id: input.newTextPartId,
            orderIndex: nextOrder++,
            type: "text",
            text,
          }
      : { ...selectedText, text };
  const modelStatePart: ModelStatePart = {
    ...base,
    id: input.statePartId,
    orderIndex: nextOrder++,
    type: "model-state",
    modelState,
  };
  const toolParts: ToolPart[] = input.tools.map((tool, index) => ({
    ...base,
    id: input.toolPartIds[index],
    orderIndex: nextOrder++,
    type: "tool",
    callId: tool.callId,
    tool: tool.name,
    state: {
      status: "pending",
      input: tool.arguments,
      raw: tool.argumentsJson,
    },
  }));
  const carrier = textPart ?? toolParts.at(0) ?? modelStatePart;
  const metadata = createTokenUsageMetadata(input.tokenUsage);
  const updatedParts: Part[] = existingParts.flatMap((part) => {
    if (part.id === selectedText?.id) return [];
    if (part.metadata?.tokenUsage === undefined) return [];
    const { tokenUsage: _usage, ...rest } = part.metadata;
    return [{ ...part, metadata: rest }];
  });
  const withUsage = <T extends Part>(part: T): T => {
    const { tokenUsage: _usage, ...rest } = part.metadata ?? {};
    return {
      ...part,
      ...(Object.keys(rest).length > 0 ||
      (part.id === carrier.id && metadata !== undefined)
        ? { metadata: { ...rest, ...(part.id === carrier.id ? metadata : {}) } }
        : { metadata: undefined }),
    };
  };
  const result: CommitModelStepResult = {
    message: {
      ...message,
      finish: input.finishReason,
      time: {
        ...message.time,
        updated: input.completedAt,
        completed: input.completedAt,
      },
    },
    modelStatePart: withUsage(modelStatePart),
    ...(textPart === undefined ? {} : { textPart: withUsage(textPart) }),
    toolParts: toolParts.map(withUsage),
  };
  if (result.textPart !== undefined && selectedText !== undefined)
    updatedParts.push(result.textPart);
  const insertedParts = [
    ...(result.textPart !== undefined && selectedText === undefined
      ? [result.textPart]
      : []),
    result.modelStatePart,
    ...result.toolParts,
  ];
  return structuredClone({ result, insertedParts, updatedParts });
}
