import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type {
  ChatCompletionMessage,
  ChatFinishReason,
  LLMClientInstance,
  ParsedToolCall,
  TokenUsage,
} from "../llm-client/index.js";
import type { MessageManager } from "../message/index.js";
import type {
  ToolCallResult,
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";

export interface LifecycleDeps {
  readonly llmClient: LLMClientInstance;
  readonly messageManager?: MessageManager;
  readonly toolScheduler?: ToolSchedulerInstance;
  readonly generateToolCallId?: () => string;
}

export interface LifecycleRunParams {
  readonly sessionId: string;
  readonly agent?: string;
  readonly parentMessageId?: string;
  readonly messages: readonly ChatCompletionMessage[];
  readonly signal?: AbortSignal;
  readonly tools?: ChatCompletionCreateParams["tools"];
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
}

export type LifecycleEvent =
  | {
      readonly type: "llm:start";
      readonly sessionId: string;
      readonly step?: number;
      readonly timestamp: number;
    }
  | {
      readonly type: "llm:delta";
      readonly sessionId: string;
      readonly step?: number;
      readonly timestamp: number;
      readonly delta: string;
      readonly content: string;
      readonly completeMessage: ChatCompletionMessage;
    }
  | {
      readonly type: "llm:complete";
      readonly sessionId: string;
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
      readonly step: number;
      readonly timestamp: number;
      readonly callId: string;
      readonly toolName: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly type: "tool:result";
      readonly sessionId: string;
      readonly step: number;
      readonly timestamp: number;
      readonly callId: string;
      readonly toolName: string;
      readonly result: ToolCallResult;
    }
  | {
      readonly type: "step:complete";
      readonly sessionId: string;
      readonly step: number;
      readonly timestamp: number;
      readonly finishReason?: ChatFinishReason;
      readonly toolResults?: readonly ToolCallResult[];
    };

export interface LifecycleResult {
  readonly success: boolean;
  readonly finishReason: ChatFinishReason | "error";
  readonly finalResponse: string;
  readonly toolCalls?: readonly ParsedToolCall[];
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}
