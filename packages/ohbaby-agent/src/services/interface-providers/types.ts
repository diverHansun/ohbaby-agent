import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";

export type InterfaceProviderKind = "openai-compatible" | "anthropic";

export type InterfaceProviderFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter";

export interface InterfaceProviderTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface InterfaceProviderToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface InterfaceProviderStreamEvent {
  textDelta?: string;
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
  tools?: ChatCompletionCreateParams["tools"];
  signal?: AbortSignal;
}

export interface CreateInterfaceProviderOptions {
  id: string;
  interfaceProvider?: InterfaceProviderKind;
  apiKey: string;
  baseUrl: string;
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
