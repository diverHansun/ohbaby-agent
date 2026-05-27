import type { UiNotice } from "ohbaby-sdk";
import type { BusInstance } from "../../bus/index.js";
import type { CommandToolSummary } from "../../commands/index.js";
import {
  createContextManager,
  type CompactResult,
  type ContextManager,
} from "../../core/context/index.js";
import { Lifecycle, type LifecycleEvent } from "../../core/lifecycle/index.js";
import type { AgentRunEventSource } from "../../core/agents/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import type { MessageManager } from "../../core/message/index.js";
import { createMemoryManager } from "../../core/memory/index.js";
import {
  createToolScheduler,
  type PermissionPort,
  type Tool,
  type ToolDefinition,
  type ToolCallResult,
} from "../../core/tool-scheduler/index.js";
import type { PermissionStateStore } from "../../permission/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/index.js";
import {
  createInMemorySessionManager,
  type SessionManager,
} from "../../services/session/index.js";
import {
  AgentManager,
  type AgentSessionStartResult,
  AgentService,
  AgentTaskManager,
  type StartSessionParams,
} from "../../agents/index.js";
import { createBuiltinTools } from "../../tools/index.js";
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
} from "../../skill/index.js";
import { McpManager } from "../../mcp/index.js";
import {
  createMcpPromptTool,
  createMcpResourceTool,
  type McpPromptReader,
  type McpResourceReader,
} from "../../mcp/integration/resource-prompt-tools.js";
import {
  RunManager,
  type HookExecutor,
  type RunDefaultsPolicy,
} from "../../runtime/run-manager/index.js";
import {
  createInMemoryStreamBridge,
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridge,
  type StreamBridgeYield,
} from "../../runtime/stream-bridge/index.js";
import {
  createHostLocalEnvironment,
  createHostLocalSandboxManager,
} from "./host-local-environment.js";
import {
  createContextSummaryClient,
  noticeFromCompactResult,
  noticeFromPromptSecurityFinding,
} from "./prompt-context.js";
import type { UiRuntimeComposition } from "./types.js";

type LlmCompleteEvent = Extract<
  LifecycleEvent,
  { readonly type: "llm:complete" }
>;

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
  readonly mcpManager?: McpManagerPort;
  readonly permission?: PermissionPort;
  readonly permissionState: PermissionStateStore;
  readonly runLedger?: RunLedger;
  readonly sessionManager?: Pick<SessionManager, "create" | "get"> &
    Partial<Pick<SessionManager, "ensureRoot">>;
  readonly skillRegistry?: SkillRegistryPort;
  readonly streamBridge?: StreamBridge;
  readonly workdir?: string;
}

export interface McpManagerPort {
  getAllTools(): Promise<readonly Tool[]>;
  getPrompt?: McpPromptReader["getPrompt"];
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

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "symbol") {
    return value.description ?? "symbol";
  }
  if (typeof value === "function") {
    return value.name ? `[function ${value.name}]` : "[function]";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
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

function objectData(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringData(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

function numberData(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];
  return typeof value === "number" ? value : undefined;
}

function lifecycleEventFromStream(
  item: Exclude<
    StreamBridgeYield,
    typeof END_SENTINEL | typeof HEARTBEAT_SENTINEL
  >,
): LifecycleEvent | undefined {
  const data = objectData(item.data);
  if (!data) {
    return undefined;
  }
  const sessionId = stringData(data, "sessionId");
  const timestamp = numberData(data, "timestamp") ?? Date.now();
  if (!sessionId) {
    return undefined;
  }

  if (item.event === "message.part.delta") {
    const content = stringData(data, "content") ?? "";
    const delta = stringData(data, "delta") ?? "";
    return {
      completeMessage: { content, role: "assistant" },
      content,
      delta,
      sessionId,
      timestamp,
      type: "llm:delta",
    };
  }
  if (item.event === "run.llm.complete") {
    return {
      completeMessage: { content: "", role: "assistant" },
      finishReason: stringData(data, "finishReason") as
        | LlmCompleteEvent["finishReason"]
        | undefined,
      sessionId,
      timestamp,
      type: "llm:complete",
    };
  }
  if (item.event === "run.tool.start") {
    return {
      callId: stringData(data, "callId") ?? "",
      params: objectData(data.params) ?? {},
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolName: stringData(data, "toolName") ?? "",
      type: "tool:start",
    };
  }
  if (item.event === "run.tool.result") {
    return {
      callId: stringData(data, "callId") ?? "",
      params: objectData(data.params) ?? {},
      result: data.result as ToolCallResult,
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolName: stringData(data, "toolName") ?? "",
      type: "tool:result",
    };
  }
  if (item.event === "run.turn.start") {
    return {
      compaction: data.compaction as Extract<
        LifecycleEvent,
        { readonly type: "turn:start" }
      >["compaction"],
      hasSummary: Boolean(data.hasSummary),
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      type: "turn:start",
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "turn:start" }
      >["usage"],
    };
  }
  if (item.event === "run.turn.end") {
    return {
      finishReason: stringData(data, "finishReason") as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["finishReason"],
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolResults: data.toolResults as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["toolResults"],
      type: "turn:end",
      usage: data.usage as Extract<
        LifecycleEvent,
        { readonly type: "turn:end" }
      >["usage"],
    };
  }
  if (item.event === "run.step.complete") {
    return {
      finishReason: stringData(data, "finishReason") as Extract<
        LifecycleEvent,
        { readonly type: "step:complete" }
      >["finishReason"],
      sessionId,
      step: numberData(data, "step") ?? 0,
      timestamp,
      toolResults: data.toolResults as Extract<
        LifecycleEvent,
        { readonly type: "step:complete" }
      >["toolResults"],
      type: "step:complete",
    };
  }
  return undefined;
}

function createStreamBridgeRunEventSource(
  streamBridge: StreamBridge,
): AgentRunEventSource {
  return {
    subscribeRunEvents(runId): AsyncIterable<LifecycleEvent> {
      return (async function* (): AsyncIterable<LifecycleEvent> {
        for await (const item of streamBridge.subscribe(`run/${runId}`, 0)) {
          if (item === END_SENTINEL) {
            return;
          }
          if (item === HEARTBEAT_SENTINEL) {
            continue;
          }
          const event = lifecycleEventFromStream(item);
          if (event) {
            yield event;
          }
        }
      })();
    },
  };
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
    permissionState: options.permissionState,
  });
  const sandboxManager = createHostLocalSandboxManager(options.workdir);
  const sessionManager =
    options.sessionManager ??
    createInMemorySessionManager({
      bus: options.bus,
      messageCleaner: options.messageManager,
      now: options.now,
    });

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
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<string> {
    const sessionAgentName = (await sessionManager.get(input.sessionId))
      ?.agentName;
    return (
      sessionAgentName ??
      (input.isSubagent ? "subagent" : agentManager.getDefault())
    );
  }

  async function resolvePromptTools(input: {
    readonly isSubagent: boolean;
    readonly sessionId: string;
  }): Promise<ToolDefinition[]> {
    const agentName = await resolvePromptAgentName(input);
    return await toolScheduler.getAvailableTools({
      agentName,
      isSubagent: input.isSubagent,
    });
  }

  function resolveSubagentTaskKind(
    agentName: string,
  ): "explore" | "research" | "plan" | "generic" {
    return agentName === "explore" ||
      agentName === "research" ||
      agentName === "plan"
      ? agentName
      : "generic";
  }

  function toolPromptGuidelines(toolNames: readonly string[]): string[] {
    const names = new Set(toolNames);
    const guidelines: string[] = [];
    if (
      names.has("bash") &&
      (names.has("grep") || names.has("glob") || names.has("list"))
    ) {
      guidelines.push(
        "Prefer read/list/glob/grep tools over bash for file exploration.",
      );
    } else if (names.has("bash")) {
      guidelines.push("Use bash for shell-assisted file and workspace tasks.");
    }
    if (names.has("write") || names.has("edit")) {
      guidelines.push(
        "Use write/edit only when the current task mode and user request allow workspace changes.",
      );
    }
    return guidelines;
  }

  const systemPromptProvider = createSystemPromptProvider({
    agentNameResolver(input) {
      return resolvePromptAgentName(input);
    },
    agentPromptResolver(agentName) {
      return agentManager.get(agentName)?.prompt;
    },
    taskKindResolver(input, agentName) {
      if (!input.isSubagent) {
        return options.permissionState.getMode() === "plan" ? "plan" : "agent";
      }
      return resolveSubagentTaskKind(agentName);
    },
    async toolDetailsProvider(input) {
      const tools = await resolvePromptTools(input);
      const toolSnippets = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description]),
      );
      return {
        promptGuidelines: toolPromptGuidelines(tools.map((tool) => tool.name)),
        toolSnippets,
      };
    },
    async toolsProvider(input) {
      const tools = await resolvePromptTools(input);
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
  const agentTaskController = new AgentTaskManager({
    agentManager,
    ...(options.createAgentTaskId
      ? { createTaskId: options.createAgentTaskId }
      : {}),
    messageManager: options.messageManager,
    modelId: options.llmClient.config.model,
    runCoordinator: runManager,
    sandboxManager,
    sessionManager,
    toolScheduler,
  });

  const agentService = new AgentService({
    agentManager,
    messageManager: options.messageManager,
    modelId: options.llmClient.config.model,
    runCoordinator: runManager,
    runEventSource,
    sandboxManager,
    sessionManager,
    toolScheduler,
  });
  const taskExecutor = agentService;

  for (const tool of createBuiltinTools({
    agentTaskController,
    taskExecutor,
  })) {
    toolScheduler.register(tool);
  }
  const skillLogger = createSkillLogger(options.onNotice);
  const skillRegistry =
    options.skillRegistry ??
    new SkillRegistry({
      loader: new SkillLoader({
        ...(skillLogger ? { logger: skillLogger } : {}),
        projectDirectory: options.workdir,
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
  let registeredMcpToolNames = new Set<string>();
  async function refreshMcpTools(): Promise<void> {
    const tools = await mcpManager.getAllTools();
    const nextToolNames = new Set(tools.map((tool) => tool.name));
    for (const toolName of registeredMcpToolNames) {
      if (!nextToolNames.has(toolName)) {
        toolScheduler.unregister(toolName);
      }
    }
    for (const tool of tools) {
      toolScheduler.register(tool);
    }
    registeredMcpToolNames = nextToolNames;
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
    runLedger,
    runManager,
    streamBridge,
    toolScheduler,

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

    setSessionWorkdir(sessionId, workdir): void {
      sandboxManager.setSessionEnvironment(
        sessionId,
        createHostLocalEnvironment(workdir),
      );
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
