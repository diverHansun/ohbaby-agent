import type { RunModel } from "../run-model.js";
import type { SlashSkillUsage } from "../../skill/usage.js";
import type { ReasoningConfig } from "ohbaby-llm";
import type { ReasoningIntent } from "ohbaby-llm";
import type {
  AgentTerminalReason,
  LifecycleEvent,
} from "../lifecycle/index.js";
import type { ModelToolDefinition } from "ohbaby-llm";
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
  /** Called after the run ledger admits current-run inputs, before model work. */
  readonly onInputReady?: () => void | Promise<void>;
  readonly runModel: RunModel;
  readonly reasoning?: ReasoningConfig | ReasoningIntent;
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
  readonly initialUserMessageId?: string;
  /** Original user text when model input includes execution-only context. */
  readonly displayUserText?: string;
  readonly skillUsage?: SlashSkillUsage;
  readonly initialUserPrompt?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  /** Cancellation applies only until the worker accepts execution. */
  readonly preparationSignal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly workdir?: string;
  readonly maxSteps?: number;
  readonly waitMode: "stream" | "waitForCompletion";
}

interface AgentRunWaitResultBase {
  readonly terminalReason?: AgentTerminalReason;
  readonly mode: "waitForCompletion";
  readonly sessionId: string;
  readonly runId?: string;
  readonly runStatus?: AgentRunCompletion["status"];
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
  readonly onInputReady?: () => void | Promise<void>;
  readonly runModel: RunModel;
  readonly preparationSignal?: AbortSignal;
  readonly reasoning?: ReasoningConfig | ReasoningIntent;
  readonly runId?: string;
  readonly sessionId: string;
  readonly agentInstanceId?: string;
  readonly contextScopeId?: string;
  readonly triggerSource: "user";
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly initiatingUserMessageId?: string;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  readonly directory: string;
  readonly projectRoot?: string;
  readonly modelId: string;
  readonly tools?: ModelToolDefinition[];
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly sessionId: string;
}

export interface AgentRunCompletion {
  readonly terminalReason?: AgentTerminalReason;
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly finalResponse?: string;
  readonly error?: string;
}

export interface AgentRunCoordinator {
  create(options: AgentRunCreateOptions): Promise<AgentRunHandle>;
  cancel(runId: string, reason?: string): void;
  revokePermissionsForRun?(runId: string, reason: string): void;
  waitForCompletion(runId: string): Promise<AgentRunCompletion>;
}

export interface AgentRunDeps {
  readonly runCoordinator: AgentRunCoordinator;
  readonly runEventSource?: AgentRunEventSource;
  readonly messageManager: MessageManager;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
}

export type AgentRunner = (
  deps: AgentRunDeps,
  input: AgentRunInput,
) => Promise<AgentRunResult>;

export type AgentInstanceType = "primary" | "sub";

export type AgentWaitMode = "stream" | "waitForCompletion";

export interface AgentInstanceIdentity {
  readonly instanceId: string;
  readonly contextScopeId?: string;
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
  readonly contextScopeId?: string;
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
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly isSubagent: boolean;
    readonly parentSessionId?: string;
  };
}

export interface AgentTurnInput {
  /** Called after the run ledger admits current-run inputs, before model work. */
  readonly onInputReady?: () => void | Promise<void>;
  readonly runModel: RunModel;
  readonly reasoning?: ReasoningConfig | ReasoningIntent;
  readonly initialUserMessageId?: string;
  /** Original user text when model input includes execution-only context. */
  readonly displayUserText?: string;
  readonly skillUsage?: SlashSkillUsage;
  readonly prompt: string;
  readonly waitMode: AgentWaitMode;
  readonly signal?: AbortSignal;
  /** Cancellation applies only until the worker accepts execution. */
  readonly preparationSignal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly runId?: string;
  readonly workdir?: string;
}

export interface AgentInstance {
  readonly identity: AgentInstanceIdentity;
  readonly contextScope: AgentContextScope;
  turn(input: AgentTurnInput): Promise<AgentRunResult>;
}

export interface AgentInstanceFactory {
  create(identity: AgentInstanceIdentity): AgentInstance;
}
