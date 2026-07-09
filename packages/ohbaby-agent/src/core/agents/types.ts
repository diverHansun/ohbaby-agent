import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { LifecycleEvent } from "../lifecycle/index.js";
import type { MessageManager } from "../message/index.js";
import type {
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";

export type AgentRunFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error";

export interface AgentToolCallSummary {
  readonly id: string;
  readonly tool: string;
  readonly status: "completed" | "error";
  readonly title?: string;
}

export interface AgentRunInput {
  readonly sessionId: string;
  readonly contextScope?: AgentContextScope;
  readonly agentInstanceId?: string;
  readonly contextScopeId?: string;
  readonly parentSessionId?: string;
  readonly isSubagent?: boolean;
  readonly agentName: string;
  readonly projectRoot: string;
  readonly modelId: string;
  readonly runId?: string;
  readonly initialUserPrompt?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
  readonly waitMode: "stream" | "waitForCompletion";
}

interface AgentRunWaitResultBase {
  readonly mode: "waitForCompletion";
  readonly sessionId: string;
  readonly runId?: string;
  readonly finishReason?: AgentRunFinishReason;
  readonly steps?: number;
  readonly toolCalls?: readonly AgentToolCallSummary[];
}

export type AgentRunResult =
  | {
      readonly mode: "stream";
      readonly sessionId: string;
      readonly runId: string;
      readonly events: AsyncIterable<LifecycleEvent>;
    }
  | (AgentRunWaitResultBase & {
      readonly success: true;
      readonly finalOutput: string;
    })
  | (AgentRunWaitResultBase & {
      readonly success: false;
      readonly error: string;
    });

export interface AgentRunEventSource {
  subscribeRunEvents(runId: string): AsyncIterable<LifecycleEvent>;
}

export interface AgentRunCreateOptions {
  readonly runId?: string;
  readonly sessionId: string;
  readonly agentInstanceId?: string;
  readonly contextScopeId?: string;
  readonly triggerSource: "user";
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  readonly directory: string;
  readonly modelId: string;
  readonly tools?: ChatCompletionCreateParams["tools"];
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly sessionId: string;
}

export interface AgentRunCompletion {
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly error?: string;
}

export interface AgentRunCoordinator {
  create(options: AgentRunCreateOptions): Promise<AgentRunHandle>;
  cancel(runId: string, reason?: string): void;
  waitForCompletion(runId: string): Promise<AgentRunCompletion>;
}

export interface AgentSandboxEnvironmentManager {
  setSessionEnvironment(
    sessionId: string,
    environment: ToolExecutionEnvironment | undefined,
  ): Promise<void> | void;
}

export interface AgentRunDeps {
  readonly runCoordinator: AgentRunCoordinator;
  readonly runEventSource?: AgentRunEventSource;
  readonly messageManager: MessageManager;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
  readonly sandboxManager?: AgentSandboxEnvironmentManager;
}

export type AgentRunner = (
  deps: AgentRunDeps,
  input: AgentRunInput,
) => Promise<AgentRunResult>;

export type AgentInstanceType = "primary" | "sub";

export type AgentWaitMode = "stream" | "waitForCompletion";

export interface AgentInstanceIdentity {
  readonly instanceId: string;
  readonly contextScopeId: string;
  readonly sessionId: string;
  readonly type: AgentInstanceType;
  readonly agentName: string;
  readonly parentSessionId?: string;
  readonly projectRoot: string;
  readonly modelId: string;
  readonly maxSteps?: number;
}

export interface AgentContextScope {
  readonly identity: AgentInstanceIdentity;
  readonly instanceId: string;
  readonly contextScopeId: string;
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly parentSessionId?: string;
  assertSession(input: {
    readonly sessionId: string;
    readonly instanceId?: string;
    readonly contextScopeId?: string;
    readonly parentSessionId?: string;
    readonly agentName?: string;
  }): void;
  toRunCreateOptions(): {
    readonly agentInstanceId: string;
    readonly contextScopeId: string;
    readonly sessionId: string;
    readonly isSubagent: boolean;
    readonly parentSessionId?: string;
  };
}

export interface AgentTurnInput {
  readonly prompt: string;
  readonly waitMode: AgentWaitMode;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly runId?: string;
}

export interface AgentInstance {
  readonly identity: AgentInstanceIdentity;
  readonly contextScope: AgentContextScope;
  turn(input: AgentTurnInput): Promise<AgentRunResult>;
}

export interface AgentInstanceFactory {
  create(identity: AgentInstanceIdentity): AgentInstance;
}
