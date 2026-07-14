import type { UiNotice } from "ohbaby-sdk";
import type { BusInstance } from "../../bus/index.js";
import type {
  CommandMcpServerSummary,
  CommandToolSummary,
} from "../../commands/index.js";
import {
  createAgentInstanceFactory,
  toOpenAiTools,
} from "../../core/agents/index.js";
import {
  createContextManager,
  type CompactResult,
  type ContextManager,
  type ContextUsage,
} from "../../core/context/index.js";
import { Lifecycle } from "../../core/lifecycle/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import type { MessageManager } from "../../core/message/index.js";
import { createMemoryManager } from "../../core/memory/index.js";
import {
  createToolScheduler,
  type PermissionPort,
  type Tool,
  type ToolDefinition,
} from "../../core/tool-scheduler/index.js";
import type { PermissionStateStore } from "../../permission/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/index.js";
import {
  createInMemorySessionManager,
  SessionEvent,
  type SessionManager,
} from "../../services/session/index.js";
import {
  AgentManager,
  type AgentSessionStartResult,
  AgentService,
  DEFAULT_SUBAGENT_ROLE,
  InMemorySubagentInstanceStore,
  SessionSubagentHost,
  type StartSessionParams,
  SUBAGENT_ROLES,
  type SubagentInstanceStore,
} from "../../agents/index.js";
import { createBuiltinTools } from "../../tools/index.js";
import {
  TodoService,
  TodoWorkScopeRegistry,
  type TodoWriteEvent,
} from "../../tools/todo.js";
import {
  GoalService,
  InMemoryGoalPersistence,
  type GoalExecutionControlPort,
  type GoalServiceDeps,
  type GoalPersistencePort,
} from "../../goals/index.js";
import {
  getDefaultSkillDirectories,
  getSearchConfig,
  loadSkillConfigLenient,
  toSearchProviderConfig,
} from "../../config/index.js";
import {
  createInMemoryRunLedger,
  type RunLedger,
} from "../../runtime/run-ledger/index.js";
import { createSystemPromptProvider } from "../../core/system-prompt/index.js";
import {
  SkillLoader,
  SkillRegistry,
  createSkillResourceTool,
  createSkillTool,
  type SkillLogger,
  type SkillRegistryPort,
  type SkillSearchDirectory,
} from "../../skill/index.js";
import {
  admitMcpTools,
  createSelectToolsTool,
  McpManager,
  McpToolMenu,
  type McpClientStatus,
} from "../../mcp/index.js";
import {
  createMcpPromptTool,
  createMcpResourceTool,
  type McpPromptReader,
  type McpResourceReader,
} from "../../mcp/integration/resource-prompt-tools.js";
import {
  RunManager,
  RunManagerNotFoundError,
  type HookExecutor,
  type RunDefaultsPolicy,
} from "../../runtime/run-manager/index.js";
import {
  createInMemoryStreamBridge,
  type StreamBridge,
} from "../../runtime/stream-bridge/index.js";
import {
  createHostLocalEnvironment,
  createHostLocalSandboxManager,
  type HostLocalSandboxManager,
} from "./host-local-environment.js";
import {
  createContextSummaryClient,
  noticeFromCompactResult,
  noticeFromPromptSecurityFinding,
} from "./prompt-context.js";
import { formatUnknown } from "./runtime-format.js";
import { createStreamBridgeRunEventSource } from "./stream-bridge-run-event-source.js";
import type { UiRuntimeComposition } from "./types.js";

const DEFAULT_RUN_POLICY: RunDefaultsPolicy = {
  defaults: {
    user: {
      permissionProfileId: "interactive",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
  },
};

export interface UiRuntimeCompositionOptions {
  readonly agentManager?: AgentManager;
  readonly createSubagentId?: () => string;
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
  readonly mcpManager?: McpManagerPort;
  readonly permission?: PermissionPort;
  readonly permissionState: PermissionStateStore;
  readonly runLedger?: RunLedger;
  readonly sandboxManager?: HostLocalSandboxManager;
  readonly sessionManager?: Pick<SessionManager, "create" | "get"> &
    Partial<Pick<SessionManager, "ensureRoot">>;
  readonly skillRegistry?: SkillRegistryPort;
  readonly streamBridge?: StreamBridge;
  readonly workdir?: string;
  /** goal 记录的持久化；缺省用内存实现（与 messageManager 的缺省姿态一致）。 */
  readonly goalPersistence?: GoalPersistencePort;
  readonly goalExecutionControl: GoalExecutionControlPort;
  readonly onGoalChange?: GoalServiceDeps["onChange"];
  readonly onTodoWrite?: (event: TodoWriteEvent) => void;
  readonly subagentInstanceStore?: SubagentInstanceStore;
  readonly subagentOwnerId?: string;
  readonly subagentOwnerPid?: number;
}

export interface McpManagerPort {
  getAllTools(): Promise<readonly Tool[]>;
  getPrompt?: McpPromptReader["getPrompt"];
  getStatus?(): Promise<Record<string, McpClientStatus>>;
  onChange?(listener: () => void | Promise<void>): () => void;
  readResource?: McpResourceReader["readResource"];
}

function supportsMcpResourceAndPromptTools(
  manager: McpManagerPort,
): manager is McpManagerPort & McpPromptReader & McpResourceReader {
  return (
    typeof manager.getPrompt === "function" &&
    typeof manager.readResource === "function"
  );
}

function formatSkillWarning(
  message: string,
  context?: Record<string, unknown>,
): string {
  const error = context?.error;
  return error === undefined ? message : `${message}: ${formatUnknown(error)}`;
}

function createSkillLogger(
  onNotice: UiRuntimeCompositionOptions["onNotice"],
): SkillLogger | undefined {
  if (!onNotice) {
    return undefined;
  }
  return {
    warn(message, context): void {
      if (context?.kind === "skill-override") {
        return;
      }

      const detail = formatSkillWarning(message, context);
      onNotice({
        key: `skill:warning:${detail}`,
        level: "warning",
        message: detail,
        title: "Skill warning",
      });
    },
  };
}

function mcpStatusToSummary(
  name: string,
  status: McpClientStatus,
): CommandMcpServerSummary {
  return { name, status: status.status };
}

async function loadConfiguredSkillDirectories(input: {
  readonly onNotice?: UiRuntimeCompositionOptions["onNotice"];
  readonly projectDirectory?: string;
}): Promise<readonly SkillSearchDirectory[]> {
  const defaultDirectories = getDefaultSkillDirectories({
    projectDirectory: input.projectDirectory,
  });
  const config = await loadSkillConfigLenient({
    onWarning(error) {
      const detail = formatUnknown(error);
      input.onNotice?.({
        key: `skill:config:${detail}`,
        level: "warning",
        message: detail,
        title: "Skill config warning",
      });
    },
    projectDirectory: input.projectDirectory,
  });
  return [...defaultDirectories, ...config.directories];
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
  const mcpToolMenu = new McpToolMenu();
  let registeredMcpToolNames = new Set<string>();
  const toolScheduler = createToolScheduler({
    accessGuard({ request, tool }) {
      if (tool.source !== "mcp" || !registeredMcpToolNames.has(tool.name)) {
        return undefined;
      }
      const loaded = mcpToolMenu.loadedNames({
        contextScopeId: request.contextScopeId,
        sessionId: request.sessionId,
      });
      return loaded.has(tool.name)
        ? undefined
        : "MCP tool is not loaded. Use select_tools with its exact name first.";
    },
    agentTools: agentManager,
    bus: options.bus,
    permission: options.permission,
    permissionState: options.permissionState,
  });
  const sandboxManager =
    options.sandboxManager ?? createHostLocalSandboxManager(options.workdir);
  const sessionManager =
    options.sessionManager ??
    createInMemorySessionManager({
      bus: options.bus,
      messageCleaner: options.messageManager,
      now: options.now,
    });
  const todoService = new TodoService({
    history: options.messageManager,
    onWarning(message, error): void {
      const detail =
        error instanceof Error ? `${message}: ${error.message}` : message;
      options.onNotice?.({
        key: `todo:recovery:${detail}`,
        level: "warning",
        message: detail,
        source: "todo",
        title: "Todo recovery warning",
      });
    },
    onWrite: options.onTodoWrite,
  });
  const todoWorkScopes = new TodoWorkScopeRegistry();

  async function ensureRootSession(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<void> {
    if (sessionManager.ensureRoot) {
      await sessionManager.ensureRoot(input);
      return;
    }
    if (await sessionManager.get(input.id)) {
      return;
    }
    await sessionManager.create(input.projectRoot, {
      agentName: input.agentName,
      id: input.id,
      title: input.title,
    });
  }
  const reservedRunIds: string[] = [];
  const nextRunId =
    options.createRunId ??
    ((): string =>
      `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

  function reserveRunId(runId = nextRunId()): string {
    reservedRunIds.push(runId);
    return runId;
  }

  function takeRunId(runId: string | undefined): string {
    return runId ?? reservedRunIds.shift() ?? nextRunId();
  }

  async function resolvePromptAgentName(input: {
    readonly agentName?: string;
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<string> {
    if (input.agentName) {
      return input.agentName;
    }
    const sessionAgentName = (await sessionManager.get(input.sessionId))
      ?.agentName;
    return (
      sessionAgentName ??
      (input.isSubagent ? "subagent" : agentManager.getDefault())
    );
  }

  async function resolvePromptTools(input: {
    readonly agentName?: string;
    readonly contextScopeId?: string;
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<ToolDefinition[]> {
    const agentName = await resolvePromptAgentName(input);
    const tools = await toolScheduler.getAvailableTools({
      agentName,
      isSubagent: input.isSubagent,
    });
    const loadedMcpTools = mcpToolMenu.loadedNames(
      {
        contextScopeId: input.contextScopeId,
        sessionId: input.sessionId,
      },
      tools,
    );
    return tools.filter(
      (tool) =>
        !registeredMcpToolNames.has(tool.name) || loadedMcpTools.has(tool.name),
    );
  }

  async function resolveMcpToolNames(input: {
    readonly agentName?: string;
    readonly contextScopeId?: string;
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<readonly string[]> {
    const agentName = await resolvePromptAgentName(input);
    const tools = await toolScheduler.getAvailableTools({
      agentName,
      isSubagent: input.isSubagent,
    });
    const loadedMcpTools = mcpToolMenu.loadedNames(
      {
        contextScopeId: input.contextScopeId,
        sessionId: input.sessionId,
      },
      tools,
    );
    return mcpToolMenu
      .selectableNames(tools)
      .filter((toolName) => !loadedMcpTools.has(toolName));
  }

  function resolveSubagentTaskKind(
    agentName: string,
  ): "explore" | "research" | "generic" {
    return agentName === "explore" || agentName === "research"
      ? agentName
      : "generic";
  }

  const systemPromptProvider = createSystemPromptProvider({
    agentNameResolver(input) {
      return resolvePromptAgentName(input);
    },
    agentPromptResolver(agentName) {
      return agentManager.get(agentName)?.prompt;
    },
    availableSubagentRolesProvider() {
      return SUBAGENT_ROLES.map((role) => {
        const agent = agentManager.get(role);
        return {
          default: role === DEFAULT_SUBAGENT_ROLE,
          description: agent?.description ?? `${role} subagent`,
          role,
        };
      });
    },
    taskKindResolver(input, agentName) {
      if (!input.isSubagent) {
        return options.permissionState.getMode() === "plan" ? "plan" : "agent";
      }
      return resolveSubagentTaskKind(agentName);
    },
    async toolsProvider(input) {
      const tools = await resolvePromptTools(input);
      return tools.map((tool) => tool.name);
    },
    mcpToolNamesProvider: resolveMcpToolNames,
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
      tokenCounter: createHeuristicTokenCounter({
        defaultLimit: options.llmClient.config.contextWindowTokens,
        profiles: options.llmClient.config.modelProfiles,
        provider: options.llmClient.config.provider,
      }),
    });
  const lifecycle = new Lifecycle({
    contextManager,
    llmClient: options.llmClient,
    messageManager: options.messageManager,
    resolveTools: async (input): Promise<ReturnType<typeof toOpenAiTools>> =>
      toOpenAiTools(
        await resolvePromptTools({
          agentName: input.agentName,
          contextScopeId: input.contextScopeId,
          isSubagent: input.isSubagent ?? false,
          sessionId: input.sessionId,
        }),
      ),
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
    runLedger,
    sandboxManager,
    streamBridge,
  });

  const runEventSource = createStreamBridgeRunEventSource(streamBridge);

  const agentInstanceFactory = createAgentInstanceFactory({
    deps: {
      messageManager: options.messageManager,
      runCoordinator: runManager,
      runEventSource,
      toolScheduler,
    },
  });
  const agentService = new AgentService({
    agentManager,
    instanceFactory: agentInstanceFactory,
    modelId: options.llmClient.config.model,
    sessionManager,
  });
  const pendingSandboxCleanups = new Set<Promise<void>>();

  const trackSandboxCleanup = (operation: Promise<void>): void => {
    const tracked = operation.catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown sandbox cleanup error";
      options.onNotice?.({
        key: `sandbox:cleanup:${message}`,
        level: "warning",
        message: `Sandbox cleanup failed: ${message}`,
        title: "Sandbox warning",
      });
    });
    pendingSandboxCleanups.add(tracked);
    void tracked.finally(() => {
      pendingSandboxCleanups.delete(tracked);
    });
  };

  const cleanupClosedSubagentScope = async (input: {
    readonly contextScopeId: string;
    readonly runId?: string;
    readonly sessionId: string;
  }): Promise<void> => {
    try {
      if (input.runId !== undefined) {
        try {
          await runManager.waitForCompletion(input.runId);
        } catch (error) {
          if (!(error instanceof RunManagerNotFoundError)) {
            throw error;
          }
        }
      }
      await sandboxManager.destroyContext({
        contextScopeId: input.contextScopeId,
        sessionId: input.sessionId,
      });
    } finally {
      todoService.releaseScope(input.sessionId, input.contextScopeId);
    }
  };

  const subagentHost = new SessionSubagentHost({
    agentManager,
    createSubagentId: options.createSubagentId,
    createRunId: options.createRunId,
    instanceFactory: agentInstanceFactory,
    modelId: options.llmClient.config.model,
    ownerId: options.subagentOwnerId,
    ownerPid: options.subagentOwnerPid,
    onClosed(input): void {
      trackSandboxCleanup(cleanupClosedSubagentScope(input));
    },
    sessionManager,
    store: options.subagentInstanceStore ?? new InMemorySubagentInstanceStore(),
    now: options.now,
  });
  await subagentHost.recoverInterrupted();

  const interruptRunTree = async (
    runId: string,
    reason?: string,
  ): Promise<void> => {
    const run = runManager.get(runId);
    const parentSessionId =
      run?.sessionId ?? (await runLedger.get(runId))?.sessionId;
    if (run) {
      runManager.cancel(runId, reason);
    }
    if (parentSessionId === undefined) {
      return;
    }
    await subagentHost.interruptByParent(
      parentSessionId,
      reason ?? "parent run interrupted",
    );
  };

  const unsubscribeSessionRemoved = options.bus.subscribe(
    SessionEvent.Removed,
    (payload) => {
      contextManager.disposeSession(payload.sessionId);
      mcpToolMenu.disposeSession(payload.sessionId);
      todoService.release(payload.sessionId);
      todoWorkScopes.release(payload.sessionId);
      trackSandboxCleanup(
        (async (): Promise<void> => {
          await subagentHost.interruptByParent(
            payload.sessionId,
            "parent session removed",
          );
          const activeRuns = runManager.list(payload.sessionId);
          for (const run of activeRuns) {
            runManager.cancel(run.runId, "session removed");
          }
          await Promise.all(
            activeRuns.map((run) => runManager.waitForCompletion(run.runId)),
          );
          await sandboxManager.destroySessionContexts(payload.sessionId);
        })(),
      );
    },
  );

  const goalService = new GoalService({
    executionControl: options.goalExecutionControl,
    onChange: (event): void => {
      options.onGoalChange?.(event);
      const status = event.snapshot?.status;
      options.onNotice?.({
        level: "info",
        message:
          event.change.kind === "completion"
            ? "Goal completed."
            : event.snapshot === null
              ? "Goal cleared."
              : `Goal ${status ?? "updated"}${event.snapshot.pauseReason ? `: ${event.snapshot.pauseReason}` : ""}`,
        source: "goals",
        title: "Goal",
      });
    },
    onError: ({ error, sessionId }): void => {
      options.onNotice?.({
        key: `goal:execution:${sessionId}:${formatUnknown(error)}`,
        level: "error",
        message: formatUnknown(error),
        source: "goals",
        title: "Goal execution control failed",
      });
    },
    persistence: options.goalPersistence ?? new InMemoryGoalPersistence(),
  });

  for (const tool of createBuiltinTools({
    goalBackend: goalService,
    searchProvider: {
      async loadConfig() {
        return toSearchProviderConfig(await getSearchConfig());
      },
    },
    subagentHost,
    todoStore: todoService,
    todoToolOptions: {
      resolveWorkScopeId: (context) =>
        todoWorkScopes.resolve(context.sessionId),
    },
  })) {
    toolScheduler.register(tool);
  }
  toolScheduler.register(createSelectToolsTool(mcpToolMenu));
  const skillLogger = createSkillLogger(options.onNotice);
  const skillRegistry =
    options.skillRegistry ??
    new SkillRegistry({
      loader: new SkillLoader({
        directories: await loadConfiguredSkillDirectories({
          onNotice: options.onNotice,
          projectDirectory: options.workdir,
        }),
        ...(skillLogger ? { logger: skillLogger } : {}),
      }),
    });
  async function refreshSkillTools(): Promise<void> {
    toolScheduler.register(await createSkillTool(skillRegistry));
    toolScheduler.register(createSkillResourceTool(skillRegistry));
  }

  await refreshSkillTools();
  skillRegistry.onChange(() => {
    void refreshSkillTools().catch((error: unknown) => {
      options.onNotice?.({
        key: `skill:tool-refresh:${formatUnknown(error)}`,
        level: "warning",
        message: formatUnknown(error),
        title: "Skill tool refresh failed",
      });
    });
  });

  const mcpManager: McpManagerPort =
    options.mcpManager ??
    McpManager.getInstance(options.workdir ?? process.cwd());
  function clearMcpTools(): void {
    for (const toolName of registeredMcpToolNames) {
      toolScheduler.unregister(toolName);
    }
    registeredMcpToolNames = new Set();
    mcpToolMenu.setAvailable([]);
  }

  async function refreshMcpTools(): Promise<void> {
    let discoveredTools: readonly Tool[];
    try {
      discoveredTools = await mcpManager.getAllTools();
    } catch (error) {
      clearMcpTools();
      throw error;
    }
    const admission = admitMcpTools(discoveredTools);
    const nextToolNames = new Set(admission.accepted.map((tool) => tool.name));
    for (const toolName of registeredMcpToolNames) {
      if (!nextToolNames.has(toolName)) {
        toolScheduler.unregister(toolName);
      }
    }
    for (const tool of admission.accepted) {
      toolScheduler.register(tool);
    }
    registeredMcpToolNames = nextToolNames;
    mcpToolMenu.setAvailable([...nextToolNames]);
    for (const rejected of admission.rejected) {
      options.onNotice?.({
        key: `mcp:tool-rejected:${rejected.name}:${rejected.reason}`,
        level: "warning",
        message:
          "An MCP tool was not loaded because its metadata failed safety checks.",
        source: "mcp",
        title: "MCP tool blocked",
      });
    }
  }

  await refreshMcpTools().catch((error: unknown) => {
    options.onNotice?.({
      key: `mcp:tool-refresh:${formatUnknown(error)}`,
      level: "warning",
      message: formatUnknown(error),
      title: "MCP tool refresh failed",
    });
  });
  mcpManager.onChange?.(() => {
    void refreshMcpTools().catch((error: unknown) => {
      options.onNotice?.({
        key: `mcp:tool-refresh:${formatUnknown(error)}`,
        level: "warning",
        message: formatUnknown(error),
        title: "MCP tool refresh failed",
      });
    });
  });
  if (supportsMcpResourceAndPromptTools(mcpManager)) {
    toolScheduler.register(createMcpResourceTool(mcpManager));
    toolScheduler.register(createMcpPromptTool(mcpManager));
  }

  return {
    agentManager,
    goals: goalService,
    todos: todoService,
    runLedger,
    runManager,
    streamBridge,
    toolScheduler,
    todoWorkScopes,

    reserveRunId,

    startSession(input: StartSessionParams): Promise<AgentSessionStartResult> {
      const runId = takeRunId(input.runId);
      return agentService.startSession({
        ...input,
        environment:
          input.environment ?? createHostLocalEnvironment(input.projectRoot),
        runId,
      });
    },

    setSessionWorkdir(sessionId, workdir): Promise<void> {
      return sandboxManager.setSessionWorkdir(sessionId, workdir);
    },

    async ensureSessionRecord(input): Promise<void> {
      await ensureRootSession({
        agentName: input.agentName,
        id: input.id,
        projectRoot: input.projectRoot,
        title: input.title,
      });
    },

    async compactSession(input): Promise<CompactResult> {
      const result = await contextManager.compact(input.sessionId, {
        directory: input.projectRoot,
        force: input.force ?? true,
        isSubagent: input.isSubagent ?? false,
        modelId: options.llmClient.config.model,
      });
      const notice = noticeFromCompactResult(input.sessionId, result);
      if (notice) {
        options.onNotice?.(notice);
      }
      return result;
    },

    async getContextUsage(input): Promise<ContextUsage> {
      const assembled = await contextManager.assemble(
        input.sessionId,
        input.projectRoot,
      );
      return contextManager.getUsage(assembled, options.llmClient.config.model);
    },

    async listMcpServerSummaries(): Promise<
      readonly CommandMcpServerSummary[]
    > {
      const statuses = await mcpManager.getStatus?.();
      if (!statuses) {
        return [];
      }
      return Object.entries(statuses)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, status]) => mcpStatusToSummary(name, status));
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

    interruptRunTree,

    interruptSubagentsByParent(parentSessionId, reason): Promise<void> {
      return subagentHost
        .interruptByParent(parentSessionId, reason)
        .then(() => undefined);
    },

    async dispose(): Promise<void> {
      unsubscribeSessionRemoved();
      todoService.dispose();
      todoWorkScopes.dispose();
      toolScheduler.cancelAll();
      await Promise.all([
        subagentHost.dispose(),
        runManager.cancelAll("runtime disposed"),
      ]);
      while (pendingSandboxCleanups.size > 0) {
        await Promise.all([...pendingSandboxCleanups]);
      }
      await sandboxManager.dispose();
    },
  };
}
