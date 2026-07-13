import type { BusInstance } from "../../bus/index.js";
import type {
  PermissionDecision,
  PermissionStateStore,
} from "../../permission/index.js";
import type {
  PreflightResult,
  TrustedRoot,
  TrustedRootKind,
} from "../../sandbox/index.js";

export type ToolCategory =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory"
  | "skill"
  | "subagent"
  | "subagent-control";

export type ToolSource = "builtin" | "module" | "skill" | "mcp";

export type ToolCallStatus =
  | "pending"
  | "checking_permission"
  | "awaiting_approval"
  | "queued"
  | "executing"
  | "success"
  | "error"
  | "rejected"
  | "cancelled";

export type FinalToolCallStatus =
  | "success"
  | "error"
  | "rejected"
  | "cancelled";

export type ToolCallErrorType =
  | "ToolNotFoundError"
  | "PermissionDeniedError"
  | "PermissionRejectedError"
  | "ExecutionError"
  | "TimeoutError"
  | "CancelledError"
  | "ValidationError";

export interface ToolCallError {
  readonly type: ToolCallErrorType;
  readonly message: string;
  readonly details?: unknown;
}

export interface ToolCommandContext {
  readonly kind: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly commandPrefix?: readonly string[];
}

export interface ToolCommandContextOptions {
  readonly fileAccess?: "none" | "workspace-ro" | "workspace-rw";
}

export interface ToolExecutionEnvironment {
  readonly workdir: string;
  containsTrustedPath?(absolutePath: string): boolean;
  resolvePath(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
  resolveCommandContext(
    options?: ToolCommandContextOptions,
  ): ToolCommandContext;
  preflight?(
    command: string,
    shellKind: PreflightResult["shellKind"],
  ): Promise<PreflightResult>;
  trustPath?(input: {
    readonly kind: TrustedRootKind;
    readonly path: string;
    readonly source?: string;
  }): Promise<TrustedRoot>;
  trustedRoots?(): readonly TrustedRoot[];
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly messageId: string;
  readonly callId: string;
  readonly environment?: ToolExecutionEnvironment;
}

export interface ToolExecutionResult {
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
  readonly source: ToolSource;
  readonly category?: ToolCategory;
  readonly timeoutOwner?: "scheduler" | "tool";
  readonly requireExplicitApproval?: boolean;
  /** @deprecated MCP trust is MCP-local metadata; scheduler uses requireExplicitApproval. */
  readonly isTrusted?: boolean;
  readonly mcpServer?: string;
  readonly mcpToolName?: string;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
  };
  execute(
    params: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> | ToolExecutionResult;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly category: ToolCategory;
  readonly source: ToolSource;
}

export interface ToolCallRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly messageId: string;
  readonly agentName?: string;
  readonly isSubagent?: boolean;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
}

export interface BatchToolCallRequest {
  readonly calls: readonly ToolCallRequest[];
}

export interface ToolCallResult {
  readonly callId: string;
  readonly status: FinalToolCallStatus;
  readonly output?: string;
  readonly metadata?: Record<string, unknown>;
  readonly error?: ToolCallError;
  readonly duration?: number;
}

export interface ToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly messageId: string;
  readonly category: ToolCategory;
  status: ToolCallStatus;
  readonly createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  result?: ToolCallResult;
  error?: ToolCallError;
}

export type PermissionResponse = "once" | "always" | "reject" | "cancel";

export interface PermissionPort {
  readonly state?: PermissionStateStore;
  ask(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly category: ToolCategory;
    readonly params: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
    readonly reason?: string;
    readonly rememberable?: boolean;
  }): PermissionResponse | Promise<PermissionResponse>;
}

export type AgentToolConfig =
  | Record<string, boolean>
  | {
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
    };

export interface AgentToolConfigProvider {
  getAgentConfig(
    agentName?: string,
  ):
    | { readonly tools?: AgentToolConfig }
    | Promise<{ readonly tools?: AgentToolConfig }>;
}

export interface ConcurrencyConfig {
  readonly maxReadConcurrency: number;
  readonly maxSubagentConcurrency: number;
}

export interface TimeoutPolicy {
  readonly defaultTimeout: number;
  readonly byTool?: Readonly<Record<string, number>>;
}

export type TimeoutConfig = TimeoutPolicy;

export interface ToolSchedulerConfig {
  readonly concurrency: ConcurrencyConfig;
  readonly timeout: TimeoutConfig;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(toolName: string): void;
  registerCategory(toolName: string, category: ToolCategory): void;
  get(toolName: string): Tool | undefined;
  getCategory(toolName: string): ToolCategory | undefined;
  getAvailableTools(input: {
    readonly tools?: Record<string, boolean>;
    readonly isSubagent?: boolean;
  }): ToolDefinition[];
  list(): ToolDefinition[];
}

export interface ToolScheduler {
  register(tool: Tool): void;
  unregister(toolName: string): void;
  registerCategory(toolName: string, category: ToolCategory): void;
  get(toolName: string): Tool | undefined;
  getCategory(toolName: string): ToolCategory | undefined;
  getAvailableTools(input?: {
    readonly agentName?: string;
    readonly isSubagent?: boolean;
  }): Promise<ToolDefinition[]>;
  execute(request: ToolCallRequest): Promise<ToolCallResult>;
  executeBatch(request: BatchToolCallRequest): Promise<ToolCallResult[]>;
  cancel(callId: string): boolean;
  cancelAll(): void;
  getStatus(callId: string): ToolCallStatus | null;
  getPendingCalls(): ToolCall[];
}

export interface ToolSchedulerOptions {
  readonly bus: BusInstance;
  readonly permissionState?: PermissionStateStore;
  readonly permission?: PermissionPort;
  readonly agentTools?: AgentToolConfigProvider;
  readonly config?: Partial<{
    readonly concurrency: Partial<ConcurrencyConfig>;
    readonly timeout: Partial<TimeoutConfig>;
  }>;
  readonly now?: () => number;
}

export type { PermissionDecision };
