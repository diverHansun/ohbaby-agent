import { AsyncLocalStorage } from "node:async_hooks";
import type { BusInstance } from "../../bus/index.js";
import { createMessage } from "./factory.js";
import { createMessageIdGenerator } from "./id-generator.js";
import { MessageEvent } from "./events.js";
import { toModelMessages as convertToModelMessages } from "./converter.js";
import type {
  MessageCommitCoordinator,
  MessageCommittedChange,
  CreateMessageInput,
  CommitModelStepInput,
  CommitModelStepResult,
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
import type { ModelMessage } from "../llm-client/index.js";

export interface MessageManagerOptions {
  readonly commitCoordinator?: MessageCommitCoordinator;
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

  let coordinator = options.commitCoordinator;
  const pending = new AsyncLocalStorage<{
    createdMessageIds: string[];
    messages: Message[];
    parts: Part[];
    removedMessageIds: string[];
    notifications: (() => void)[];
  }>();

  function publish(
    event: typeof MessageEvent.Updated,
    payload: { info: Message },
  ): void;
  function publish(
    event: typeof MessageEvent.PartUpdated,
    payload: { part: Part; delta?: string },
  ): void;
  function publish(
    event: typeof MessageEvent.Removed,
    payload: { sessionId: string; messageId: string },
  ): void;
  function publish(
    _event:
      | typeof MessageEvent.Updated
      | typeof MessageEvent.PartUpdated
      | typeof MessageEvent.Removed,
    payload:
      | { info: Message }
      | { part: Part; delta?: string }
      | { sessionId: string; messageId: string },
  ): void {
    const notify = (): void => {
      if ("info" in payload) options.bus.publish(MessageEvent.Updated, payload);
      else if ("part" in payload)
        options.bus.publish(MessageEvent.PartUpdated, payload);
      else options.bus.publish(MessageEvent.Removed, payload);
    };
    const current = pending.getStore();
    if (current === undefined) {
      notify();
      return;
    }
    if ("info" in payload) current.messages.push(payload.info);
    else if ("part" in payload) current.parts.push(payload.part);
    else current.removedMessageIds.push(payload.messageId);
    current.notifications.push(notify);
  }

  function commit<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const owner = coordinator;
    if (owner === undefined) return operation();
    return owner.run(sessionId, async () => {
      const changes = {
        createdMessageIds: [] as string[],
        messages: [] as Message[],
        parts: [] as Part[],
        removedMessageIds: [] as string[],
        notifications: [] as (() => void)[],
      };
      const result = await pending.run(changes, operation);
      if (
        changes.messages.length +
          changes.parts.length +
          changes.removedMessageIds.length >
        0
      ) {
        const change: MessageCommittedChange = {
          sessionId,
          ...(changes.createdMessageIds.length === 0
            ? {}
            : { createdMessageIds: changes.createdMessageIds }),
          messages: changes.messages,
          parts: changes.parts,
          removedMessageIds: changes.removedMessageIds,
        };
        try {
          owner.onCommitted(change);
        } catch (error) {
          owner.onProjectionError(sessionId, error);
        }
      }
      for (const notify of changes.notifications) notify();
      return result;
    });
  }

  async function commitMessage<T>(
    messageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return commit((await getExistingMessage(messageId)).sessionId, operation);
  }

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
    pending.getStore()?.createdMessageIds.push(message.id);
    publish(MessageEvent.Updated, { info: message });
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
    if (part.type !== "model-state")
      publish(MessageEvent.PartUpdated, { part });
    return part;
  }

  async function updatePart(
    partId: string,
    patch: UpdatePartPatch,
  ): Promise<Part> {
    const { delta, ...storePatch } = patch;
    const part = await options.store.updatePart(partId, storePatch, now());
    const payload = delta === undefined ? { part } : { part, delta };
    if (part.type !== "model-state") publish(MessageEvent.PartUpdated, payload);
    return part;
  }

  async function getExistingMessage(messageId: string): Promise<Message> {
    const message = await options.store.getMessage(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    return message;
  }

  const manager: MessageManager = {
    getPart: (partId) => options.store.getPart(partId),
    setCommitCoordinator(value) {
      coordinator = value;
    },
    saveReasoningPart(input) {
      return options.store.saveReasoningPart({ ...input, updatedAt: now() });
    },
    listPageBySession: (sessionId, page) =>
      options.store.listPageBySession(sessionId, page),
    listPageByRun: (sessionId, runId, page) =>
      options.store.listPageByRun(sessionId, runId, page),
    listByIds: (sessionId, ids) => options.store.listByIds(sessionId, ids),
    async commitModelStep(
      input: CommitModelStepInput,
    ): Promise<CommitModelStepResult> {
      const result = await options.store.commitModelStep({
        ...input,
        statePartId: idGenerator.partId(),
        newTextPartId: idGenerator.partId(),
        toolPartIds: input.tools.map(() => idGenerator.partId()),
      });
      if (result.textPart !== undefined)
        publish(MessageEvent.PartUpdated, {
          part: result.textPart,
        });
      for (const part of result.toolParts)
        publish(MessageEvent.PartUpdated, { part });
      publish(MessageEvent.Updated, { info: result.message });
      return result;
    },
    createMessage: createMessageRecord,

    async updateMessage(
      messageId: string,
      patch: UpdateMessagePatch,
    ): Promise<Message> {
      const message = await options.store.updateMessage(messageId, patch);
      publish(MessageEvent.Updated, { info: message });
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
        publish(MessageEvent.PartUpdated, { part: result.part });
      }
      return result.part;
    },
    updatePart,

    async commitCompaction(
      input: CommitCompactionInput,
    ): Promise<CommitCompactionResult | undefined> {
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
        expectedParts: input.expectedParts,
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
      if (result === undefined) {
        return undefined;
      }
      if (result.summary !== undefined) {
        pending.getStore()?.createdMessageIds.push(result.summary.message.id);
        publish(MessageEvent.Updated, {
          info: result.summary.message,
        });
        publish(MessageEvent.PartUpdated, {
          part: result.summary.part,
        });
      }
      for (const part of result.updatedParts) {
        if (part.type !== "model-state")
          publish(MessageEvent.PartUpdated, { part });
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
      publish(MessageEvent.Removed, {
        sessionId: message.sessionId,
        messageId,
      });
    },

    async removeMessages(sessionId: string): Promise<void> {
      const messages = await options.store.listBySession(sessionId);
      await options.store.deleteBySession(sessionId);
      for (const message of messages) {
        publish(MessageEvent.Removed, {
          sessionId,
          messageId: message.info.id,
        });
      }
    },

    async toModelMessages(
      sessionId: string,
      filter?: MessageScopeFilter,
    ): Promise<ModelMessage[]> {
      return convertToModelMessages(
        await options.store.listBySession(sessionId, filter),
      );
    },
  };
  return {
    runtimeInputMemory: options.store.runtimeInputMemory,
    ...manager,
    createMessage: (input) =>
      commit(input.sessionId, () => manager.createMessage(input)),
    updateMessage: (id, patch) =>
      commitMessage(id, () => manager.updateMessage(id, patch)),
    appendPart: (id, input) =>
      commitMessage(id, () => manager.appendPart(id, input)),
    appendModelContextPart: (id, text) =>
      commitMessage(id, () => manager.appendModelContextPart(id, text)),
    async updatePart(id, patch): Promise<Part> {
      const part = await options.store.getPart(id);
      if (part === undefined) throw new Error(`Part not found: ${id}`);
      return commit(part.sessionId, () => manager.updatePart(id, patch));
    },
    commitModelStep: (input) =>
      commitMessage(input.assistantMessageId, () =>
        manager.commitModelStep(input),
      ),
    commitCompaction: (input) =>
      commit(input.sessionId, () => manager.commitCompaction(input)),
    removeMessage: (id) => commitMessage(id, () => manager.removeMessage(id)),
    removeMessages: (id) => commit(id, () => manager.removeMessages(id)),
  };
}
