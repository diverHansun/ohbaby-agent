import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { LifecycleEvent } from "../lifecycle/index.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";
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

/**
 * Transitional until lifecycle improve-2 moves prompt assembly into the
 * session run path.
 */
export type AgentPromptMessageBuilder = (input: {
  readonly agentName: string;
  readonly isSubagent: boolean;
  readonly projectRoot: string;
  readonly sessionId: string;
}) => Promise<readonly ChatCompletionMessage[]>;

export interface AgentRunInput {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agentName: string;
  readonly projectRoot: string;
  readonly initialUserPrompt?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
  readonly waitMode: "stream" | "waitForCompletion";
  readonly buildPromptMessages: AgentPromptMessageBuilder;
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
      readonly finalOutput?: string;
    });

export interface AgentRunEventSource {
  subscribeRunEvents(runId: string): AsyncIterable<LifecycleEvent>;
}

export interface AgentRunCreateOptions {
  readonly sessionId: string;
  readonly triggerSource: "user";
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  /**
   * Transitional until lifecycle improve-2 lets the run path assemble messages
   * through Lifecycle.runSession.
   */
  readonly messages: readonly ChatCompletionMessage[];
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
  ): void;
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
