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

export interface AgentRunResult {
  readonly sessionId: string;
  readonly runId?: string;
  readonly success: boolean;
  readonly finishReason?: AgentRunFinishReason;
  readonly finalOutput?: string;
  readonly events?: AsyncIterable<LifecycleEvent>;
  readonly steps?: number;
  readonly toolCalls?: readonly AgentToolCallSummary[];
  readonly error?: string;
}

export interface AgentRunCreateOptions {
  readonly sessionId: string;
  readonly triggerSource: "user";
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  readonly messages: readonly ChatCompletionMessage[];
  readonly tools?: ChatCompletionCreateParams["tools"];
}

export interface AgentRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: string;
  readonly status: string;
  readonly permissionProfileId: string;
  readonly multitaskStrategy: string;
  readonly disconnectMode: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
}

export interface AgentRunCompletion {
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly error?: string;
}

export interface AgentRunCoordinator {
  create(options: AgentRunCreateOptions): Promise<AgentRunRecord>;
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
  readonly messageManager: Pick<MessageManager, "listBySession"> &
    Partial<Pick<MessageManager, "appendPart" | "createMessage">>;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
  readonly sandboxManager?: AgentSandboxEnvironmentManager;
}

export type AgentRunner = (
  deps: AgentRunDeps,
  input: AgentRunInput,
) => Promise<AgentRunResult>;
