import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { UiNotice } from "ohbaby-sdk";
import type { BusInstance } from "../../bus/index.js";
import type { CommandToolSummary } from "../../commands/index.js";
import {
  createContextManager,
  type ContextManager,
} from "../../core/context/index.js";
import { Lifecycle } from "../../core/lifecycle/index.js";
import type {
  ChatCompletionMessage,
  LLMClientInstance,
} from "../../core/llm-client/index.js";
import type {
  MessageManager,
  MessageWithParts,
} from "../../core/message/index.js";
import { createMemoryManager } from "../../core/memory/index.js";
import {
  createToolScheduler,
  type PermissionPort,
  type PolicyPort,
  type ToolDefinition,
} from "../../core/tool-scheduler/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/index.js";
import type { SessionManager } from "../../services/session/index.js";
import {
  AgentManager,
  SubagentExecutor,
  type SubagentRunner,
  type SubagentSession,
  type SubagentSessionManager,
} from "../../agents/index.js";
import { createBuiltinTools } from "../../tools/index.js";
import {
  createInMemoryRunLedger,
  type RunLedger,
} from "../../runtime/run-ledger/index.js";
import { createSystemPromptProvider } from "../../core/system-prompt/index.js";
import {
  RunManager,
  type HookExecutor,
  type ProfileRegistry,
  type RunDefaultsPolicy,
} from "../../runtime/run-manager/index.js";
import {
  createInMemoryStreamBridge,
  type StreamBridge,
} from "../../runtime/stream-bridge/index.js";
import {
  createHostLocalEnvironment,
  createHostLocalSandboxManager,
} from "./host-local-environment.js";
import {
  appendMemoryToSystemPrompt,
  createContextSummaryClient,
  loadMemoryForPrompt,
  noticeFromCompactResult,
  noticeFromPromptSecurityFinding,
} from "./prompt-context.js";
import type { UiRuntimeComposition } from "./types.js";

const DEFAULT_RUN_POLICY: RunDefaultsPolicy = {
  defaults: {
    user: {
      permissionProfileId: "interactive",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    scheduler: {
      permissionProfileId: "read-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    heartbeat: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    channel: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    "follow-up": {
      permissionProfileId: "full-auto",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
  },
};

const DEFAULT_PROFILE_REGISTRY: ProfileRegistry = {
  getProfile(id: string) {
    return { id };
  },
};

export interface UiRuntimeCompositionOptions {
  readonly agentManager?: AgentManager;
  readonly bus: BusInstance;
  readonly contextManager?: ContextManager;
  readonly createRunId?: () => string;
  readonly llmClient: LLMClientInstance;
  readonly messageManager: MessageManager;
  readonly now?: () => number;
  readonly onNotice?: (
    notice: Omit<UiNotice, "id" | "createdAt"> & {
      readonly createdAt?: string;
    },
  ) => void;
  readonly hookExecutor?: HookExecutor;
  readonly permission?: PermissionPort;
  readonly policy: PolicyPort;
  readonly runLedger?: RunLedger;
  readonly sessionManager?: Pick<SessionManager, "create" | "get">;
  readonly streamBridge?: StreamBridge;
  readonly workdir?: string;
}

interface RuntimeSubagentSessionManager extends SubagentSessionManager {
  ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void>;
}

class InMemorySubagentSessionManager implements RuntimeSubagentSessionManager {
  private readonly sessions = new Map<string, SubagentSession>();
  private nextId = 1;

  ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void> {
    const existing = this.sessions.get(input.id);
    this.sessions.set(input.id, {
      id: input.id,
      agentName: input.agentName,
      childrenIds: existing?.childrenIds ?? [],
      isSubagent: false,
      projectRoot: input.projectRoot,
    });
    return Promise.resolve();
  }

  create(
    projectDirectory: string,
    options: {
      readonly id?: string;
      readonly title?: string;
      readonly agentName?: string;
      readonly parentId?: string;
    } = {},
  ): Promise<SubagentSession> {
    const id = options.id ?? `subagent_session_${String(this.nextId)}`;
    this.nextId += 1;
    const parent = options.parentId
      ? this.sessions.get(options.parentId)
      : undefined;
    const session: SubagentSession = {
      id,
      agentName: options.agentName ?? "build",
      childrenIds: [],
      isSubagent: options.parentId !== undefined,
      parentId: options.parentId,
      projectRoot: parent?.projectRoot ?? projectDirectory,
    };

    this.sessions.set(id, session);
    if (parent && !parent.childrenIds.includes(id)) {
      this.sessions.set(parent.id, {
        ...parent,
        childrenIds: [...parent.childrenIds, id],
      });
    }

    return Promise.resolve(session);
  }

  get(sessionId: string): Promise<SubagentSession | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }
}

class PersistentSubagentSessionManager implements RuntimeSubagentSessionManager {
  constructor(
    private readonly backing: Pick<SessionManager, "create" | "get">,
  ) {}

  async ensureRoot(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void> {
    if (await this.backing.get(input.id)) {
      return;
    }
    await this.backing.create(input.projectRoot, {
      agentName: input.agentName,
      id: input.id,
      title: input.title,
    });
  }

  create(
    projectDirectory: string,
    options: {
      readonly id?: string;
      readonly title?: string;
      readonly agentName?: string;
      readonly parentId?: string;
    } = {},
  ): Promise<SubagentSession> {
    return this.backing.create(projectDirectory, options);
  }

  get(sessionId: string): Promise<SubagentSession | null> {
    return this.backing.get(sessionId);
  }
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

function textFromMessage(message: MessageWithParts): string {
  return message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function lastAssistantText(messages: readonly MessageWithParts[]): string {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  return assistant ? textFromMessage(assistant) : "";
}

function withoutSystemMessages(
  messages: readonly ChatCompletionMessage[],
): ChatCompletionMessage[] {
  return messages.filter((message) => message.role !== "system");
}

export async function createUiRuntimeComposition(
  options: UiRuntimeCompositionOptions,
): Promise<UiRuntimeComposition> {
  const agentManager = options.agentManager ?? new AgentManager();
  await agentManager.initialize();

  const runLedger =
    options.runLedger ??
    createInMemoryRunLedger({
      now: options.now,
    });
  const streamBridge =
    options.streamBridge ??
    createInMemoryStreamBridge({ heartbeatIntervalMs: 0 });
  const toolScheduler = createToolScheduler({
    agentTools: agentManager,
    bus: options.bus,
    permission: options.permission,
    policy: options.policy,
  });
  const sandboxManager = createHostLocalSandboxManager(options.workdir);
  const sessionManager: RuntimeSubagentSessionManager = options.sessionManager
    ? new PersistentSubagentSessionManager(options.sessionManager)
    : new InMemorySubagentSessionManager();
  const subagentSessionAgents = new Map<string, string>();
  let activePrimaryAgentName = agentManager.getDefault();
  const reservedRunIds: string[] = [];
  const nextRunId =
    options.createRunId ??
    ((): string =>
      `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

  function reserveRunId(runId = nextRunId()): string {
    reservedRunIds.push(runId);
    return runId;
  }

  function abortReason(signal: AbortSignal): string {
    return typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "subagent run aborted";
  }

  function bindSubagentAbort(
    runId: string,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) {
      return () => undefined;
    }
    const abort = (): void => {
      try {
        runManager.cancel(runId, abortReason(signal));
      } catch {
        // The child run may already be terminal.
      }
    };
    if (signal.aborted) {
      abort();
      return () => undefined;
    }
    signal.addEventListener("abort", abort, { once: true });
    return () => {
      signal.removeEventListener("abort", abort);
    };
  }

  async function resolveSubagentAgentName(
    sessionId: string,
  ): Promise<string | undefined> {
    const cached = subagentSessionAgents.get(sessionId);
    if (cached) {
      return cached;
    }
    return (await sessionManager.get(sessionId))?.agentName;
  }

  async function resolvePromptAgentName(input: {
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<string> {
    if (!input.isSubagent) {
      return activePrimaryAgentName;
    }
    return (await resolveSubagentAgentName(input.sessionId)) ?? "subagent";
  }

  async function buildRunMessages(input: {
    readonly agentName: string;
    readonly isSubagent: boolean;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<ChatCompletionMessage[]> {
    if (input.isSubagent) {
      subagentSessionAgents.set(input.sessionId, input.agentName);
    } else {
      activePrimaryAgentName = input.agentName;
    }
    const compactResult = await contextManager.compact(input.sessionId, {
      directory: input.projectRoot,
      isSubagent: input.isSubagent,
      modelId: options.llmClient.config.model,
    });
    const notice = noticeFromCompactResult(input.sessionId, compactResult);
    if (notice) {
      options.onNotice?.(notice);
    }

    const context = await contextManager.assemble(
      input.sessionId,
      input.projectRoot,
      input.isSubagent,
    );
    const systemPrompt = input.isSubagent
      ? context.systemPrompt
      : appendMemoryToSystemPrompt(
          context.systemPrompt,
          loadMemoryForPrompt(context.memory.merged, (finding) => {
            options.onNotice?.(noticeFromPromptSecurityFinding(finding));
          }),
        );
    const history = withoutSystemMessages(
      await options.messageManager.toModelMessages(input.sessionId),
    );
    if (systemPrompt.trim() === "") {
      return history;
    }
    return [{ role: "system", content: systemPrompt }, ...history];
  }

  const subagentRunner: SubagentRunner = {
    async run(input): Promise<{
      readonly output: string;
      readonly steps?: number;
      readonly success: boolean;
      readonly toolCalls?: readonly [];
    }> {
      subagentSessionAgents.set(input.sessionId, input.agentName);
      const tools = await toolScheduler.getAvailableTools({
        agentName: input.agentName,
        isSubagent: true,
      });
      sandboxManager.setSessionEnvironment(input.sessionId, input.environment);
      try {
        const messages = await buildRunMessages({
          agentName: input.agentName,
          isSubagent: true,
          projectRoot: input.projectRoot ?? options.workdir ?? process.cwd(),
          sessionId: input.sessionId,
        });
        const record = await runManager.create({
          agent: input.agentName,
          isSubagent: true,
          maxSteps: input.runtimeAgent.config.maxSteps,
          messages,
          parentMessageId: input.parentMessageId,
          sessionId: input.sessionId,
          tools: toOpenAiTools(tools),
          triggerSource: "user",
        });
        const unbindAbort = bindSubagentAbort(record.runId, input.signal);
        try {
          const completion = await runManager.waitForCompletion(record.runId);
          const messages = await options.messageManager.listBySession(
            input.sessionId,
          );
          const output = lastAssistantText(messages);
          return {
            output: output !== "" ? output : (completion.error ?? ""),
            steps: 0,
            success: completion.status === "succeeded",
            toolCalls: [],
          };
        } finally {
          unbindAbort();
        }
      } finally {
        sandboxManager.setSessionEnvironment(input.sessionId, undefined);
      }
    },
  };

  const taskExecutor = new SubagentExecutor({
    agentManager,
    messageWriter: {
      async writeUserMessage(input): Promise<{ readonly messageId: string }> {
        const message = await options.messageManager.createMessage({
          agent: input.agentName,
          role: "user",
          sessionId: input.sessionId,
        });
        await options.messageManager.appendPart(message.id, {
          text: input.prompt,
          type: "text",
        });
        return { messageId: message.id };
      },
      async writeAssistantMessage(input): Promise<void> {
        const message = await options.messageManager.createMessage({
          agent: input.agentName,
          parentId: input.parentMessageId,
          role: "assistant",
          sessionId: input.sessionId,
        });
        await options.messageManager.appendPart(message.id, {
          text: input.output,
          type: "text",
        });
        await options.messageManager.updateMessage(message.id, {
          error: {
            message: input.output,
            name: "Unknown",
          },
          finish: "error",
        });
      },
    },
    runner: subagentRunner,
    sessionManager,
  });

  for (const tool of createBuiltinTools({ taskExecutor })) {
    toolScheduler.register(tool);
  }

  const systemPromptProvider = createSystemPromptProvider({
    agentNameResolver(input) {
      return resolvePromptAgentName(input);
    },
    agentPromptResolver(agentName) {
      return agentManager.get(agentName)?.prompt;
    },
    async toolsProvider(input) {
      const agentName = input.isSubagent
        ? await resolveSubagentAgentName(input.sessionId)
        : activePrimaryAgentName;
      const tools = await toolScheduler.getAvailableTools({
        agentName,
        isSubagent: input.isSubagent,
      });
      return tools.map((tool) => tool.name);
    },
    onSecurityFinding(finding) {
      options.onNotice?.(noticeFromPromptSecurityFinding(finding));
    },
  });
  const contextManager =
    options.contextManager ??
    createContextManager({
      bus: options.bus,
      llmClient: createContextSummaryClient(options.llmClient),
      memory: createMemoryManager({ bus: options.bus }),
      messageManager: options.messageManager,
      now: options.now,
      onWarning(message, error) {
        const detail =
          error instanceof Error ? `${message}: ${error.message}` : message;
        options.onNotice?.({
          key: `context:warning:${detail}`,
          level: "warning",
          message: detail,
          title: "Context warning",
        });
      },
      systemPromptProvider,
      tokenCounter: createHeuristicTokenCounter(),
    });

  const lifecycle = new Lifecycle({
    llmClient: options.llmClient,
    messageManager: options.messageManager,
    toolScheduler,
  });

  const runManager = new RunManager({
    createRunId(): string {
      return reservedRunIds.shift() ?? nextRunId();
    },
    lifecycle,
    hookExecutor: options.hookExecutor,
    now: options.now,
    policy: DEFAULT_RUN_POLICY,
    profileRegistry: DEFAULT_PROFILE_REGISTRY,
    runLedger,
    sandboxManager,
    streamBridge,
  });

  return {
    agentManager,
    runLedger,
    runManager,
    streamBridge,
    toolScheduler,

    reserveRunId,

    setSessionWorkdir(sessionId, workdir): void {
      sandboxManager.setSessionEnvironment(
        sessionId,
        createHostLocalEnvironment(workdir),
      );
    },

    async ensureSessionRecord(input): Promise<void> {
      await sessionManager.ensureRoot({
        agentName: input.agentName,
        id: input.id,
        projectRoot: input.projectRoot,
        title: input.title,
      });
    },

    async getOpenAiTools(input): Promise<ChatCompletionCreateParams["tools"]> {
      return toOpenAiTools(
        await toolScheduler.getAvailableTools({
          agentName: input.agentName,
          isSubagent: input.isSubagent,
        }),
      );
    },

    async buildPromptMessages(input): Promise<ChatCompletionMessage[]> {
      return buildRunMessages({
        agentName: input.agentName,
        isSubagent: false,
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
      });
    },

    async listToolSummaries(
      input = {},
    ): Promise<readonly CommandToolSummary[]> {
      return (
        await toolScheduler.getAvailableTools({ agentName: input.agentName })
      ).map((tool) => ({
        category: tool.category,
        description: tool.description,
        name: tool.name,
        source: tool.source,
      }));
    },

    cancel(runId, reason): void {
      runManager.cancel(runId, reason);
    },
  };
}
