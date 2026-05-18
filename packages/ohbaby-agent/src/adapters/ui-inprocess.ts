import fs from "node:fs/promises";
import path from "node:path";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommandCatalog,
  UiCommandInvocation,
  UiEvent,
  UiEventHandler,
  UiInteractionResponse,
  UiMessage,
  UiMessagePart,
  UiPermissionRequest,
  UiPermissionResponse,
  UiRun,
  UiRunStatus,
  UiSnapshot,
  UiToolCall,
  UiSession,
} from "ohbaby-sdk";
import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import { createLLMClient } from "../core/llm-client/index.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import { Lifecycle } from "../core/lifecycle/index.js";
import { createBus } from "../bus/index.js";
import {
  createToolScheduler,
  type ToolDefinition,
  type ToolExecutionEnvironment,
} from "../core/tool-scheduler/index.js";
import type {
  CommandModelSummary,
  CommandSessionSummary,
} from "../commands/index.js";
import { CommandsEvent, createCommandService } from "../commands/index.js";
import {
  createInteractionBroker,
  InteractionEvent,
} from "../runtime/interaction-broker/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type { MessageManager } from "../core/message/index.js";
import type {
  Session as CoreSession,
  SessionManager,
} from "../services/session/index.js";
import {
  createPermissionManager,
  PermissionEvent,
} from "../permission/index.js";
import type {
  PermissionInfo,
  PermissionResponse as CorePermissionResponse,
} from "../permission/index.js";
import { createPolicyManager } from "../policy/index.js";
import { BUILTIN_TOOLS } from "../tools/index.js";
import {
  cloneMessage,
  cloneRun,
  cloneSession,
  createInMemoryUiStateStore,
} from "./ui-state/index.js";
import type { UiStateStore } from "./ui-state/index.js";

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
  readonly sessionManager?: Pick<
    SessionManager,
    "create" | "get" | "getRecent"
  >;
  readonly stateStore?: UiStateStore;
  readonly projectDirectory?: string;
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

function sessionMetadataToUiSession(session: CoreSession): UiSession {
  return {
    createdAt: new Date(session.createdAt).toISOString(),
    id: session.id,
    messages: [],
    title: session.title,
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

function normalizeForBoundary(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  const withoutTrailingSeparator =
    resolved.length > root.length ? resolved.replace(/[\\/]+$/u, "") : resolved;
  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolved);
  if (normalizedRoot === normalizedCandidate) {
    return resolved;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

function resolveHostPath(workdir: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workdir, inputPath);
}

function createHostLocalEnvironment(
  workdir = process.cwd(),
): ToolExecutionEnvironment {
  const root = path.resolve(workdir);

  return {
    workdir: root,
    resolvePath(inputPath: string): string {
      return assertInsideWorkdir(
        root,
        inputPath,
        resolveHostPath(root, inputPath),
      );
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(resolveHostPath(root, inputPath));
      return assertInsideWorkdir(root, inputPath, resolved);
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = resolveHostPath(root, inputPath);
      const realParent = await fs.realpath(path.dirname(target));
      const resolved = path.join(realParent, path.basename(target));
      return assertInsideWorkdir(root, inputPath, resolved);
    },
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return {
        cwd: root,
        kind: "host-local",
      };
    },
  };
}

function toOpenAiTools(
  definitions: readonly ToolDefinition[],
): ChatCompletionCreateParams["tools"] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));
}

function upsertAssistantTextPart(input: {
  readonly append: boolean;
  readonly message: UiMessage;
  readonly text: string;
}): UiMessage {
  const textPartIndex = input.message.parts.findLastIndex(
    (part) => part.type === "text",
  );
  if (!input.append && textPartIndex >= 0) {
    const text = input.text;

    return {
      ...input.message,
      parts: input.message.parts.map(
        (part, index): UiMessagePart =>
          index === textPartIndex ? { type: "text", text } : part,
      ),
    };
  }

  return {
    ...input.message,
    parts: [...input.message.parts, { type: "text", text: input.text }],
  };
}

function toUiPermissionRequest(input: {
  readonly info: PermissionInfo;
  readonly runId: string;
}): UiPermissionRequest {
  return {
    id: input.info.id,
    runId: input.runId,
    title: input.info.title,
    description: input.info.pattern,
    choices: [
      { id: "allow_once", label: "Allow once", intent: "allow" },
      { id: "allow_always", label: "Always allow", intent: "allow" },
      { id: "reject", label: "Reject", intent: "deny" },
      { id: "cancel", label: "Cancel run", intent: "abort" },
    ],
  };
}

function toCorePermissionResponse(
  response: UiPermissionResponse,
): CorePermissionResponse {
  if (response.choiceId === "allow_once") {
    return { type: "once" };
  }
  if (response.choiceId === "allow_always" || response.remember === true) {
    return { type: "always" };
  }
  if (response.choiceId === "cancel") {
    return { type: "cancel" };
  }

  return { type: "reject" };
}

export function createInProcessUiBackendClient(
  optionsOrSnapshot: UiSnapshot | InProcessUiBackendOptions = EMPTY_SNAPSHOT,
): UiBackendClient {
  const options = isSnapshot(optionsOrSnapshot)
    ? { initialSnapshot: optionsOrSnapshot }
    : optionsOrSnapshot;
  const initialSnapshot = options.initialSnapshot ?? EMPTY_SNAPSHOT;
  const stateStore = options.stateStore ?? createInMemoryUiStateStore(initialSnapshot);
  const bus = createBus();
  const policy = createPolicyManager({ bus });
  const permission = createPermissionManager({ bus });
  const toolScheduler = createToolScheduler({ bus, permission, policy });
  for (const tool of BUILTIN_TOOLS) {
    toolScheduler.register(tool);
  }
  const messageManager =
    options.messageManager ??
    createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
  const interactionBroker = createInteractionBroker({ bus });
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
  let activeAbortController: AbortController | undefined;
  let activeRunId: string | undefined;
  const pendingPermissionSessions = new Map<string, string>();

  function assertStateStoreWritable(): void {
    if (
      stateStore.requiresServiceManagersForWrites === true &&
      (!options.sessionManager || !options.messageManager)
    ) {
      throw new Error(
        "Persistent UI state store requires injected sessionManager and messageManager for prompt submission",
      );
    }
  }

  async function reserveIdsFromState(): Promise<void> {
    const snapshot = await stateStore.readSnapshot();
    for (const session of snapshot.sessions) {
      sessionIds.reserve(session.id);
      for (const message of session.messages) {
        messageIds.reserve(message.id);
      }
    }
    for (const run of snapshot.runs) {
      runIds.reserve(run.id);
    }
  }

  async function nextRunId(): Promise<string> {
    let runId = runIds.next();
    while ((await stateStore.hasRun?.(runId)) === true) {
      runId = runIds.next();
    }
    return runId;
  }

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
    publish({ type: "runtime.updated", status, timestamp: Date.now() });
  }

  async function updateActiveRunStatus(status: UiRunStatus): Promise<void> {
    const runId = activeRunId;
    if (!runId) {
      return;
    }
    const snapshot = await stateStore.readSnapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      return;
    }
    const updatedRun = {
      ...run,
      status,
      updatedAt: timestamp(),
    };
    await updateRun(updatedRun);
    publish({ type: "run.updated", run: cloneRun(updatedRun) });
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

  function currentModelFromOptions(): CommandModelSummary | null {
    const client = options.llmClient;
    if (!client) {
      return null;
    }
    return {
      id: `${client.config.provider}:${client.config.model}`,
      label: client.config.model,
      provider: client.config.provider,
    };
  }

  function listModelsFromOptions(): readonly CommandModelSummary[] {
    const current = currentModelFromOptions();
    return current ? [current] : [];
  }

  async function listSessionsFromState(): Promise<
    readonly CommandSessionSummary[]
  > {
    if (options.sessionManager) {
      const sessions = await options.sessionManager.getRecent();
      return sessions.map((session) => ({
        id: session.id,
        title: session.title,
      }));
    }
    const snapshot = await stateStore.readSnapshot();
    return snapshot.sessions.map((session) => ({
      id: session.id,
      title: session.title,
    }));
  }

  function appendToolCallPart(input: {
    readonly message: UiMessage;
    readonly callId: string;
    readonly name: string;
    readonly params: Record<string, unknown>;
  }): UiMessage {
    return {
      ...input.message,
      parts: [
        ...input.message.parts,
        {
          type: "tool-call",
          call: {
            id: input.callId,
            input: input.params,
            name: input.name,
            status: "running",
          },
        },
      ],
    };
  }

  function appendToolResultPart(input: {
    readonly message: UiMessage;
    readonly callId: string;
    readonly output?: string;
    readonly error?: string;
  }): UiMessage {
    const status: UiToolCall["status"] = input.error ? "failed" : "completed";
    return {
      ...input.message,
      parts: [
        ...input.message.parts.map((part) =>
          part.type === "tool-call" && part.call.id === input.callId
            ? {
                ...part,
                call: {
                  ...part.call,
                  status,
                },
              }
            : part,
        ),
        {
          type: "tool-result",
          result: {
            callId: input.callId,
            output: input.output ?? "",
            error: input.error,
          },
        },
      ],
    };
  }

  const commandService = createCommandService({
    bus,
    interactionBroker,
    tools: {
      listTools() {
        return BUILTIN_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          category: tool.category,
          source: tool.source,
        }));
      },
    },
    models: {
      currentModel: currentModelFromOptions,
      listModels: listModelsFromOptions,
    },
    sessions: {
      listSessions: listSessionsFromState,
    },
    abortRun(runId?: string): void {
      if (!runId) {
        activeAbortController?.abort("run aborted");
        interactionBroker.abortAll("aborted");
        return;
      }
      if (runId === activeRunId) {
        activeAbortController?.abort("run aborted");
        return;
      }
      commandService.abortCommandRun(runId, "aborted");
    },
    getStatus(): string {
      return promptInFlight ? "running" : "idle";
    },
  });

  bus.subscribe(CommandsEvent.Started, (payload) => {
    publish({
      type: "command.started",
      command: {
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        commandId: payload.commandId,
        path: payload.path,
        surface: payload.surface,
        sessionId: payload.sessionId,
      },
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(CommandsEvent.ResultDelivered, (payload) => {
    publish({
      type: "command.result.delivered",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      output: payload.output,
      action: payload.action,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(CommandsEvent.Failed, (payload) => {
    publish({
      type: "command.failed",
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      error: payload.error,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(InteractionEvent.Requested, (payload) => {
    publish({
      type: "interaction.requested",
      request: payload.request,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(InteractionEvent.Resolved, (payload) => {
    publish({
      type: "interaction.resolved",
      interactionId: payload.interactionId,
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      status: payload.response.kind,
      timestamp: payload.timestamp,
    });
  });
  bus.subscribe(PermissionEvent.Updated, (payload) => {
    void (async (): Promise<void> => {
      const request = toUiPermissionRequest({
        info: payload.info,
        runId: activeRunId ?? payload.info.callId,
      });
      pendingPermissionSessions.set(payload.info.id, payload.info.sessionId);
      await stateStore.upsertPermission(request);
      const waitingStatus: UiRunStatus = {
        kind: "waiting-for-permission",
        requestId: request.id,
      };
      await updateActiveRunStatus(waitingStatus);
      await updateStatus(waitingStatus);
      publish({
        type: "permission.requested",
        request,
        timestamp: Date.now(),
      });
    })();
  });
  bus.subscribe(PermissionEvent.Replied, (payload) => {
    void (async (): Promise<void> => {
      pendingPermissionSessions.delete(payload.permissionId);
      await stateStore.removePermission(payload.permissionId);
      publish({
        type: "permission.resolved",
        requestId: payload.permissionId,
        timestamp: Date.now(),
      });
      if (promptInFlight && activeRunId) {
        const runningStatus: UiRunStatus = {
          kind: "running",
          runId: activeRunId,
        };
        await updateActiveRunStatus(runningStatus);
        await updateStatus(runningStatus);
      }
    })();
  });
  bus.subscribe(PermissionEvent.SwitchModeRequested, () => {
    policy.setAgentState("edit-automatically");
  });

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

    listCommands(query): Promise<UiCommandCatalog> {
      return Promise.resolve(commandService.listCommands(query));
    },

    async submitPrompt(
      text: string,
      submitOptions?: SubmitPromptOptions,
    ): Promise<void> {
      if (promptInFlight) {
        throw new Error("A prompt is already running");
      }
      assertStateStoreWritable();

      promptInFlight = true;
      activeAbortController = new AbortController();
      const createdAt = timestamp();

      try {
        await reserveIdsFromState();
        let session = submitOptions?.sessionId
          ? await stateStore.getSession(submitOptions.sessionId)
          : undefined;
        if (!session && submitOptions?.sessionId && options.sessionManager) {
          const existingSession = await options.sessionManager.get(
            submitOptions.sessionId,
          );
          session = existingSession
            ? sessionMetadataToUiSession(existingSession)
            : undefined;
        }

        const isNewSession = !session;
        if (!session) {
          const title = text.trim().slice(0, 48) || "Untitled session";
          if (options.sessionManager) {
            const created = await options.sessionManager.create(
              options.projectDirectory ?? process.cwd(),
              {
                agentName: "default",
                id: submitOptions?.sessionId,
                title,
              },
            );
            session = sessionMetadataToUiSession(created);
          } else {
            session = {
              id: submitOptions?.sessionId ?? sessionIds.next(),
              title,
              messages: [],
              createdAt,
              updatedAt: createdAt,
            };
          }
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

        const runId = await nextRunId();
        activeRunId = runId;
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
          const availableTools = await toolScheduler.getAvailableTools({
            agentName: "default",
          });
          const executionEnvironment = createHostLocalEnvironment();
          const lifecycle = new Lifecycle({
            llmClient: await resolveLLMClient(),
            messageManager,
            toolScheduler,
          });
          const loop = lifecycle.run({
            sessionId: session.id,
            agent: "default",
            environment: executionEnvironment,
            parentMessageId: coreUserMessage.id,
            messages: toModelMessages(
              session.messages.filter(
                (message) => message.id !== assistantMessage.id,
              ),
            ),
            signal: activeAbortController.signal,
            tools: toOpenAiTools(availableTools),
          });

          let assistantTextStep: number | undefined;
          let next = await loop.next();
          while (!next.done) {
            if (next.value.type === "llm:delta") {
              const updatedAssistant = upsertAssistantTextPart({
                append: assistantTextStep !== next.value.step,
                message: assistantMessage,
                text: next.value.content,
              });
              assistantTextStep = next.value.step;
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
              publish({
                type: "message.part.delta",
                sessionId: session.id,
                messageId: updatedAssistant.id,
                delta: next.value.delta,
                content: next.value.content,
                timestamp: next.value.timestamp,
              });
            }

            if (next.value.type === "tool:start") {
              const updatedAssistant = appendToolCallPart({
                message: assistantMessage,
                callId: next.value.callId,
                name: next.value.toolName,
                params: next.value.params,
              });
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

            if (next.value.type === "tool:result") {
              const updatedAssistant = appendToolResultPart({
                message: assistantMessage,
                callId: next.value.callId,
                output: next.value.result.output,
                error: next.value.result.error?.message,
              });
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
        activeAbortController = undefined;
        activeRunId = undefined;
      }
    },

    executeCommand(invocation: UiCommandInvocation): Promise<void> {
      return commandService.executeCommand(invocation);
    },

    respondPermission(
      requestId: string,
      response: UiPermissionResponse,
    ): Promise<void> {
      const sessionId = pendingPermissionSessions.get(requestId);
      if (!sessionId) {
        return Promise.resolve();
      }
      permission.respond(
        sessionId,
        requestId,
        toCorePermissionResponse(response),
      );
      return Promise.resolve();
    },

    respondInteraction(
      interactionId: string,
      response: UiInteractionResponse,
    ): Promise<void> {
      return interactionBroker.respond(interactionId, response);
    },

    abortRun(runId?: string): Promise<void> {
      if (!runId) {
        activeAbortController?.abort("run aborted");
        interactionBroker.abortAll("aborted");
      } else if (runId === activeRunId) {
        activeAbortController?.abort("run aborted");
      } else {
        commandService.abortCommandRun(runId, "aborted");
      }
      return Promise.resolve();
    },
  };
}
