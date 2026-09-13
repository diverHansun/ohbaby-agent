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

interface ModelCacheBreakpoint {
  readonly prompt_cache_breakpoint?: { readonly mode: "explicit" };
}
export interface ModelTextPart extends ModelCacheBreakpoint {
  readonly type: "text";
  readonly text: string;
  readonly cacheControl?: {
    readonly type: "ephemeral";
    readonly ttl?: "5m" | "1h";
  };
}
export interface ModelImagePart extends ModelCacheBreakpoint {
  readonly type: "image_url";
  readonly image_url: {
    readonly url: string;
    readonly detail?: "auto" | "low" | "high";
  };
}
export interface ModelAudioPart extends ModelCacheBreakpoint {
  readonly type: "input_audio";
  readonly input_audio: {
    readonly data: string;
    readonly format: "wav" | "mp3";
  };
}
export interface ModelFilePart extends ModelCacheBreakpoint {
  readonly type: "file";
  readonly file: {
    readonly file_data?: string;
    readonly file_id?: string;
    readonly filename?: string;
  };
}
export interface ModelRefusalPart {
  readonly type: "refusal";
  readonly refusal: string;
}
export interface ModelToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}
export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}
export type ModelMessage =
  | {
      readonly role: "system";
      readonly content: string | readonly ModelTextPart[];
      readonly name?: string;
    }
  | {
      readonly role: "developer";
      readonly content: string | readonly ModelTextPart[];
      readonly name?: string;
    }
  | {
      readonly role: "user";
      readonly content:
        | string
        | readonly (
            | ModelTextPart
            | ModelImagePart
            | ModelAudioPart
            | ModelFilePart
          )[];
      readonly name?: string;
    }
  | {
      readonly role: "assistant";
      readonly content?:
        | string
        | readonly (ModelTextPart | ModelRefusalPart)[]
        | null;
      readonly name?: string;
      readonly toolCalls?: readonly ModelToolCall[];
      readonly reasoningText?: string;
      readonly refusal?: string | null;
      readonly audio?: { readonly id: string } | null;
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly content: string | readonly ModelTextPart[];
    };

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
  messages: readonly ModelMessage[];
  temperature: number;
  maxTokens: number;
  tools?: readonly ModelToolDefinition[];
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
