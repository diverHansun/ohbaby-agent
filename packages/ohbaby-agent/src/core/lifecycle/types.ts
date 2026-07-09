import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type {
  ChatCompletionMessage,
  ChatFinishReason,
  LLMClientInstance,
  ParsedToolCall,
  ProviderRetryEvent,
  TokenUsage,
} from "../llm-client/index.js";
import type {
  CompactResult,
  ContextManager,
  ContextUsage,
  PreparedTurn,
} from "../context/index.js";
import type { MessageManager } from "../message/index.js";
import type {
  ToolCallResult,
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";

export interface LifecycleDeps {
  readonly llmClient: LLMClientInstance;
  readonly messageManager: MessageManager;
  readonly toolScheduler: ToolSchedulerInstance;
  readonly contextManager: ContextManager;
  readonly generateToolCallId?: () => string;
}

export interface LifecycleSessionParams {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly modelId: string;
  readonly agent?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly tools?: ChatCompletionCreateParams["tools"];
  readonly environment?: ToolExecutionEnvironment;
  readonly isSubagent?: boolean;
  readonly maxSteps?: number;
}

export interface TurnContext {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly step: number;
  readonly prepared: PreparedTurn;
  readonly finishReason?: ChatFinishReason | "error";
  readonly finalResponse: string;
  readonly toolResults?: readonly ToolCallResult[];
}

export interface ToolCallContext {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly step: number;
  readonly callId: string;
  readonly toolName: string;
  readonly params: Record<string, unknown>;
}

export interface BeforeToolCallResult {
  readonly note?: string;
}

export interface AfterToolCallResult {
  readonly note?: string;
}

export interface LifecycleConfig {
  readonly shouldStopAfterTurn?: (ctx: TurnContext) => boolean;
  readonly beforeToolCall?: (
    ctx: ToolCallContext,
  ) => Promise<BeforeToolCallResult | undefined>;
  readonly afterToolCall?: (
    ctx: ToolCallContext & { readonly result: ToolCallResult },
  ) => Promise<AfterToolCallResult | undefined>;
}

export type AgentTerminalReason =
  | "completed"
  | "cancelled"
  | "max_steps_finalized"
  | "max_steps_finalization_requested_tool"
  | "provider_retry_exhausted"
  | "provider_stream_interrupted"
  | "tool_parse_failure"
  | "context_overflow";

export type LifecycleEvent =
  | {
      readonly type: "turn:start";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly usage: ContextUsage;
      readonly compaction?: CompactResult;
      readonly hasSummary: boolean;
    }
  | {
      readonly type: "context:prepared";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly usage: ContextUsage;
      readonly compaction?: CompactResult;
      readonly hasSummary: boolean;
    }
  | {
      readonly type: "turn:end";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly usage: ContextUsage;
      readonly finishReason?: ChatFinishReason | "error";
      readonly toolResults?: readonly ToolCallResult[];
    }
  | {
      readonly type: "llm:start";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step?: number;
      readonly timestamp: number;
    }
  | ({
      readonly type: "llm:retrying";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step?: number;
      readonly timestamp: number;
    } & ProviderRetryEvent)
  | {
      readonly type: "llm:delta";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step?: number;
      readonly timestamp: number;
      readonly delta: string;
      readonly content: string;
      readonly completeMessage: ChatCompletionMessage;
    }
  | {
      readonly type: "llm:reasoning-delta";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly messageId: string;
      readonly step?: number;
      readonly timestamp: number;
      readonly delta: string;
      readonly content: string;
    }
  | {
      readonly type: "llm:reasoning-end";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly messageId: string;
      readonly step?: number;
      readonly timestamp: number;
      readonly content: string;
    }
  | {
      readonly type: "llm:complete";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step?: number;
      readonly timestamp: number;
      readonly finishReason?: ChatFinishReason;
      readonly completeMessage: ChatCompletionMessage;
      readonly parsedToolCalls?: readonly ParsedToolCall[];
      readonly tokenUsage?: TokenUsage;
    }
  | {
      readonly type: "tool:start";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly callId: string;
      readonly toolName: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly type: "tool:result";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly callId: string;
      readonly toolName: string;
      readonly params: Record<string, unknown>;
      readonly result: ToolCallResult;
    }
  | {
      readonly type: "step:complete";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly finishReason?: ChatFinishReason;
      readonly toolResults?: readonly ToolCallResult[];
    };

export interface LifecycleResult {
  readonly success: boolean;
  readonly finishReason: ChatFinishReason | "error";
  readonly finalResponse: string;
  readonly terminalReason?: AgentTerminalReason;
  readonly toolCalls?: readonly ParsedToolCall[];
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}
