import type {
  ModelResponseSnapshot,
  ModelFinishReason,
  ModelToolDefinition,
  LLMClientInstance,
  ParsedToolCall,
  ProviderRetryEvent,
  TokenUsage,
} from "../llm-client/index.js";
import type {
  CompactResult,
  ContextManager,
  ContextOccupancyComposition,
  ContextUsage,
  PreparedTurn,
} from "../context/index.js";
import type { MessageManager } from "../message/index.js";
import type {
  ToolCallResult,
  ToolDefinition,
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";

export interface LifecycleDeps {
  readonly llmClient: LLMClientInstance;
  readonly messageManager: MessageManager;
  readonly toolScheduler: ToolSchedulerInstance;
  readonly contextManager: ContextManager;
  readonly resolveTools?: (
    input: LifecycleToolResolutionInput,
  ) => Promise<ResolvedStepTools | undefined> | ResolvedStepTools | undefined;
  readonly generateToolCallId?: () => string;
}

export interface ResolvedStepTools {
  readonly definitions: readonly ToolDefinition[] | undefined;
  readonly requestTools: readonly ModelToolDefinition[] | undefined;
}

export interface LifecycleToolResolutionInput {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly agentName?: string;
  readonly isSubagent?: boolean;
  readonly step: number;
}

export interface LifecycleSessionParams {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly modelId: string;
  readonly agent?: string;
  /** User message created for this run; absent for resume/continuation runs. */
  readonly initiatingUserMessageId?: string;
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly tools?: readonly ModelToolDefinition[] | undefined;
  readonly environment?: ToolExecutionEnvironment;
  readonly isSubagent?: boolean;
  readonly maxSteps?: number;
}

export interface TurnContext {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly step: number;
  readonly prepared: PreparedTurn;
  readonly finishReason?: ModelFinishReason | "error";
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
  | "context_overflow"
  | "output_length";

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
      readonly type: "context:compacting";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "context:prepared";
      readonly sessionId: string;
      readonly contextScopeId?: string;
      readonly step: number;
      readonly timestamp: number;
      readonly usage: ContextUsage;
      readonly composition?: ContextOccupancyComposition;
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
      readonly finishReason?: ModelFinishReason | "error";
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
      /** May be absent on observation-only projections. */
      readonly messageSnapshot?: ModelResponseSnapshot;
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
      readonly finishReason?: ModelFinishReason;
      /** May be absent when the observation transport has no response body. */
      readonly messageSnapshot?: ModelResponseSnapshot;
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
      readonly finishReason?: ModelFinishReason;
      readonly toolResults?: readonly ToolCallResult[];
    };

export interface LifecycleResult {
  readonly success: boolean;
  readonly finishReason: ModelFinishReason | "error";
  readonly finalResponse: string;
  readonly terminalReason?: AgentTerminalReason;
  /** In-memory only; consumers must normalize and redact before persistence. */
  readonly failureCause?: unknown;
  readonly toolCalls?: readonly ParsedToolCall[];
  /** Aggregate token usage collected during this Lifecycle.run invocation. */
  readonly usage?: LifecycleTokenUsage;
}

/** Aggregate usage for one Lifecycle.run, not an individual provider call or session. */
export interface LifecycleTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputBreakdown?: TokenUsage["inputBreakdown"];
  /**
   * True when every aggregated result included usage; excludes unaggregated HTTP attempts.
   * Independent of lifecycle completion and cache-field observation.
   */
  readonly usageComplete: boolean;
}
