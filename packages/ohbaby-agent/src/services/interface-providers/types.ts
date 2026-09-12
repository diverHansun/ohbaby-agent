import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type { TokenUsageDiagnosticReporter } from "./token-usage.js";

export type InterfaceProviderKind =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic";

export type LLMRequestPurpose =
  | "agent-step"
  | "context-summary"
  | "session-title";

export type PromptCacheRequestStrategy =
  | "observe-only"
  | "openai-keyed-implicit"
  | "anthropic-top-level-auto"
  | "anthropic-explicit-last-block";

export type InterfaceProviderPromptCache =
  | {
      readonly strategy: "openai-keyed-implicit";
      readonly key: string;
      readonly reason: string;
    }
  | {
      readonly strategy: Exclude<
        PromptCacheRequestStrategy,
        "openai-keyed-implicit"
      >;
      readonly key?: never;
      readonly reason: string;
    };

export type InterfaceProviderFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

export interface InputTokenBreakdown {
  readonly uncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly observed: {
    readonly cacheRead: boolean;
    readonly cacheWrite: boolean;
  };
}

export interface InterfaceProviderTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputBreakdown?: InputTokenBreakdown;
}

export interface InterfaceProviderToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

/** Function tools supported by the agent's provider-neutral request boundary. */
export interface InterfaceProviderFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

export type InterfaceProviderFunctionTools =
  | InterfaceProviderFunctionTool[]
  | undefined;

export interface InterfaceProviderStreamEvent {
  textDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: InterfaceProviderToolCallDelta[];
  finishReason?: InterfaceProviderFinishReason;
  rawFinishReason?: string;
  tokenUsage?: InterfaceProviderTokenUsage;
}

export interface InterfaceProviderRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
  tools?: InterfaceProviderFunctionTool[];
  signal?: AbortSignal;
  purpose?: LLMRequestPurpose;
  sessionId?: string;
  contextScopeId?: string;
  promptCache: InterfaceProviderPromptCache;
}

export interface CreateInterfaceProviderOptions {
  id: string;
  interfaceProvider?: InterfaceProviderKind;
  apiKey: string;
  baseUrl: string;
  readonly tokenUsageReporter?: TokenUsageDiagnosticReporter;
}

export interface InterfaceProviderInstance<TClient = unknown> {
  id: string;
  kind: InterfaceProviderKind;
  client: TClient;
  streamChatCompletion(
    request: InterfaceProviderRequest,
  ): Promise<AsyncIterable<InterfaceProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}
