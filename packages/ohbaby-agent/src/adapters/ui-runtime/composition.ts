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
import type { MessageManager } from "../../core/message/index.js";
import { createMemoryManager } from "../../core/memory/index.js";
import {
  createToolScheduler,
  type PermissionPort,
  type PolicyPort,
} from "../../core/tool-scheduler/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/index.js";
import type { SessionManager } from "../../services/session/index.js";
import {
  AgentManager,
  AgentTaskManager,
  SubagentExecutor,
  createRuntimeSubagentSessionManager,
  createSubagentMessageWriter,
  createSubagentRunner,
  toOpenAiTools,
  type RuntimeSubagentSessionManager,
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
  readonly createAgentTaskId?: () => string;
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
  const sessionManager: RuntimeSubagentSessionManager =
    createRuntimeSubagentSessionManager(options.sessionManager);
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

  async function buildSessionPromptMessages(input: {
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

  function buildPrimaryPromptMessages(input: {
    readonly agentName: string;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<ChatCompletionMessage[]> {
    return buildSessionPromptMessages({
      ...input,
      isSubagent: false,
    });
  }

  function buildSubagentPromptMessages(input: {
    readonly agentName: string;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<ChatCompletionMessage[]> {
    subagentSessionAgents.set(input.sessionId, input.agentName);
    return buildSessionPromptMessages({
      ...input,
      isSubagent: true,
    });
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

  const subagentRunner = createSubagentRunner({
    buildSubagentPromptMessages,
    fallbackProjectRoot: options.workdir,
    messageManager: options.messageManager,
    runManager,
    sandboxManager,
    toolScheduler,
  });

  const messageWriter = createSubagentMessageWriter(options.messageManager);
  const agentTaskController = new AgentTaskManager({
    agentManager,
    ...(options.createAgentTaskId
      ? { createTaskId: options.createAgentTaskId }
      : {}),
    messageWriter,
    runner: subagentRunner,
    sessionManager,
  });

  const taskExecutor = new SubagentExecutor({
    agentManager,
    messageWriter,
    runner: subagentRunner,
    sessionManager,
  });

  for (const tool of createBuiltinTools({ agentTaskController, taskExecutor })) {
    toolScheduler.register(tool);
  }

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
      return buildPrimaryPromptMessages(input);
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
