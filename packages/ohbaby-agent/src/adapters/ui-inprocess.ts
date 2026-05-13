import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommand,
  UiEvent,
  UiEventHandler,
  UiMessage,
  UiPermissionResponse,
  UiRun,
  UiRunStatus,
  UiSnapshot,
  UiSession,
} from "ohbaby-sdk";
import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import { createLLMClient } from "../core/llm-client/index.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import { Lifecycle } from "../core/lifecycle/index.js";
import { createBus } from "../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type { MessageManager } from "../core/message/index.js";
import {
  cloneMessage,
  cloneRun,
  cloneSession,
  createInMemoryCoreStateStore,
} from "../core/state/index.js";

const EMPTY_SNAPSHOT: UiSnapshot = {
  sessions: [],
  activeSessionId: null,
  runs: [],
  permissions: [],
  status: {
    kind: "idle",
  },
};

export interface InProcessUiBackendOptions {
  readonly initialSnapshot?: UiSnapshot;
  readonly llmClient?: LLMClientInstance;
  readonly createLLMClient?: () => Promise<LLMClientInstance>;
  readonly messageManager?: MessageManager;
  readonly now?: () => Date;
}

function isSnapshot(
  value: UiSnapshot | InProcessUiBackendOptions,
): value is UiSnapshot {
  return "sessions" in value && "runs" in value && "status" in value;
}

function createId(prefix: string, value: number): string {
  return `${prefix}_${String(value)}`;
}

function getNumericSuffix(prefix: string, id: string): number | undefined {
  const prefixWithSeparator = `${prefix}_`;
  if (!id.startsWith(prefixWithSeparator)) {
    return undefined;
  }

  const value = Number(id.slice(prefixWithSeparator.length));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

interface IdFactory {
  next(): string;
  reserve(id: string): void;
}

function createIdFactory(
  prefix: string,
  existingIds: Iterable<string>,
): IdFactory {
  const usedIds = new Set(existingIds);
  const numericSuffixes = Array.from(usedIds)
    .map((id) => getNumericSuffix(prefix, id))
    .filter((value): value is number => value !== undefined);
  let nextValue =
    numericSuffixes.length === 0 ? 1 : Math.max(...numericSuffixes) + 1;

  function reserve(id: string): void {
    usedIds.add(id);
    const numericSuffix = getNumericSuffix(prefix, id);
    if (numericSuffix !== undefined && numericSuffix >= nextValue) {
      nextValue = numericSuffix + 1;
    }
  }

  return {
    next(): string {
      let id = createId(prefix, nextValue);
      while (usedIds.has(id)) {
        nextValue += 1;
        id = createId(prefix, nextValue);
      }
      reserve(id);
      return id;
    },
    reserve,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function textFromMessage(message: UiMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function toModelMessages(
  messages: readonly UiMessage[],
): ChatCompletionMessage[] {
  return messages
    .filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "system",
    )
    .map((message) => ({
      role: message.role as "user" | "assistant" | "system",
      content: textFromMessage(message),
    }));
}

function createTextMessage(input: {
  id: string;
  role: UiMessage["role"];
  text: string;
  createdAt: string;
}): UiMessage {
  return {
    id: input.id,
    role: input.role,
    createdAt: input.createdAt,
    parts: input.text === "" ? [] : [{ type: "text", text: input.text }],
  };
}

export function createInProcessUiBackendClient(
  optionsOrSnapshot: UiSnapshot | InProcessUiBackendOptions = EMPTY_SNAPSHOT,
): UiBackendClient {
  const options = isSnapshot(optionsOrSnapshot)
    ? { initialSnapshot: optionsOrSnapshot }
    : optionsOrSnapshot;
  const initialSnapshot = options.initialSnapshot ?? EMPTY_SNAPSHOT;
  const stateStore = createInMemoryCoreStateStore(initialSnapshot);
  const messageManager =
    options.messageManager ??
    createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
    });
  const handlers = new Set<UiEventHandler>();
  const sessionIds = createIdFactory(
    "session",
    initialSnapshot.sessions.map((session) => session.id),
  );
  const messageIds = createIdFactory(
    "message",
    initialSnapshot.sessions.flatMap((session) =>
      session.messages.map((message) => message.id),
    ),
  );
  const runIds = createIdFactory(
    "run",
    initialSnapshot.runs.map((run) => run.id),
  );
  let promptInFlight = false;

  function now(): Date {
    return options.now?.() ?? new Date();
  }

  function timestamp(): string {
    return now().toISOString();
  }

  function publish(event: UiEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // UI event handlers are observers; they must not break backend state.
      }
    }
  }

  function upsertSession(session: UiSession): Promise<void> {
    return stateStore.upsertSession(session);
  }

  function updateRun(run: UiRun): Promise<void> {
    return stateStore.updateRun(run);
  }

  async function updateStatus(status: UiRunStatus): Promise<void> {
    await stateStore.setStatus(status);
    publish({ type: "status.updated", status });
  }

  async function resolveLLMClient(): Promise<LLMClientInstance> {
    if (options.llmClient) {
      return options.llmClient;
    }
    if (options.createLLMClient) {
      return options.createLLMClient();
    }
    return createLLMClient();
  }

  return {
    getSnapshot(): Promise<UiSnapshot> {
      return stateStore.readSnapshot();
    },

    subscribeEvents(handler: UiEventHandler) {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },

    async submitPrompt(
      text: string,
      submitOptions?: SubmitPromptOptions,
    ): Promise<void> {
      if (promptInFlight) {
        throw new Error("A prompt is already running");
      }

      promptInFlight = true;
      const createdAt = timestamp();

      try {
        let session = submitOptions?.sessionId
          ? await stateStore.getSession(submitOptions.sessionId)
          : undefined;

        const isNewSession = !session;
        if (!session) {
          session = {
            id: submitOptions?.sessionId ?? sessionIds.next(),
            title: text.trim().slice(0, 48) || "Untitled session",
            messages: [],
            createdAt,
            updatedAt: createdAt,
          };
          sessionIds.reserve(session.id);
        }

        const userMessage = createTextMessage({
          id: messageIds.next(),
          role: "user",
          text,
          createdAt,
        });
        const coreUserMessage = await messageManager.createMessage({
          sessionId: session.id,
          role: "user",
          agent: "default",
        });
        await messageManager.appendPart(coreUserMessage.id, {
          type: "text",
          text,
        });

        if (isNewSession) {
          await upsertSession(session);
          publish({ type: "session.updated", session: cloneSession(session) });
        }

        await stateStore.setActiveSessionId(session.id);

        session = {
          ...session,
          messages: [...session.messages, userMessage],
          updatedAt: createdAt,
        };
        await upsertSession(session);
        publish({
          type: "message.appended",
          sessionId: session.id,
          message: cloneMessage(userMessage),
        });

        const runId = runIds.next();
        let run: UiRun = {
          id: runId,
          sessionId: session.id,
          status: { kind: "running", runId },
          startedAt: createdAt,
          updatedAt: createdAt,
        };
        await stateStore.addRun(run);
        await updateStatus(run.status);
        publish({ type: "run.updated", run: cloneRun(run) });

        let assistantMessage = createTextMessage({
          id: messageIds.next(),
          role: "assistant",
          text: "",
          createdAt: timestamp(),
        });
        session = {
          ...session,
          messages: [...session.messages, assistantMessage],
          updatedAt: timestamp(),
        };
        await upsertSession(session);
        publish({
          type: "message.appended",
          sessionId: session.id,
          message: cloneMessage(assistantMessage),
        });

        try {
          const lifecycle = new Lifecycle({
            llmClient: await resolveLLMClient(),
            messageManager,
          });
          const loop = lifecycle.run({
            sessionId: session.id,
            agent: "default",
            parentMessageId: coreUserMessage.id,
            messages: toModelMessages(
              session.messages.filter(
                (message) => message.id !== assistantMessage.id,
              ),
            ),
          });

          let next = await loop.next();
          while (!next.done) {
            if (next.value.type === "llm:delta") {
              const updatedAssistant: UiMessage = {
                ...assistantMessage,
                parts: [{ type: "text", text: next.value.content }],
              };
              const updatedMessages: UiMessage[] = session.messages.map(
                (message) =>
                  message.id === updatedAssistant.id
                    ? updatedAssistant
                    : message,
              );
              session = {
                ...session,
                messages: updatedMessages,
                updatedAt: timestamp(),
              };
              assistantMessage = updatedAssistant;
              await upsertSession(session);
              publish({
                type: "message.updated",
                sessionId: session.id,
                message: cloneMessage(updatedAssistant),
              });
            }

            next = await loop.next();
          }

          if (!next.value.success) {
            throw new Error("Lifecycle did not complete successfully");
          }

          run = {
            ...run,
            status: { kind: "idle" },
            updatedAt: timestamp(),
          };
          await updateRun(run);
          publish({ type: "run.updated", run: cloneRun(run) });
          await updateStatus({ kind: "idle" });
        } catch (error) {
          const status: UiRunStatus = {
            kind: "error",
            message: getErrorMessage(error),
            recoverable: true,
          };
          run = {
            ...run,
            status,
            updatedAt: timestamp(),
          };
          await updateRun(run);
          publish({ type: "run.updated", run: cloneRun(run) });
          await updateStatus(status);
          throw error;
        }
      } finally {
        promptInFlight = false;
      }
    },

    executeCommand(_command: UiCommand): Promise<void> {
      return Promise.resolve();
    },

    respondPermission(
      _requestId: string,
      _response: UiPermissionResponse,
    ): Promise<void> {
      return Promise.resolve();
    },

    abortRun(_runId?: string): Promise<void> {
      return Promise.resolve();
    },
  };
}
