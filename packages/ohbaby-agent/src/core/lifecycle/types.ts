import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type {
  ChatCompletionMessage,
  ChatFinishReason,
  LLMClientInstance,
  ParsedToolCall,
  TokenUsage,
} from "../llm-client/index.js";
import type { MessageManager } from "../message/index.js";

export interface LifecycleDeps {
  readonly llmClient: LLMClientInstance;
  readonly messageManager?: MessageManager;
}

export interface LifecycleRunParams {
  readonly sessionId: string;
  readonly agent?: string;
  readonly parentMessageId?: string;
  readonly messages: readonly ChatCompletionMessage[];
  readonly signal?: AbortSignal;
  readonly tools?: ChatCompletionCreateParams["tools"];
}

export type LifecycleEvent =
  | {
      readonly type: "llm:start";
      readonly sessionId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: "llm:delta";
      readonly sessionId: string;
      readonly timestamp: number;
      readonly delta: string;
      readonly content: string;
      readonly completeMessage: ChatCompletionMessage;
    }
  | {
      readonly type: "llm:complete";
      readonly sessionId: string;
      readonly timestamp: number;
      readonly finishReason?: ChatFinishReason;
      readonly completeMessage: ChatCompletionMessage;
      readonly parsedToolCalls?: readonly ParsedToolCall[];
      readonly tokenUsage?: TokenUsage;
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
