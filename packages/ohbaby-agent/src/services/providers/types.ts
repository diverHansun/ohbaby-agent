import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';

export type ProviderKind = 'openai-compatible' | 'anthropic';

export type ProviderFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export interface ProviderTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ProviderToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ProviderStreamEvent {
  textDelta?: string;
  toolCallDeltas?: ProviderToolCallDelta[];
  finishReason?: ProviderFinishReason;
  rawFinishReason?: string;
  tokenUsage?: ProviderTokenUsage;
}

export interface ProviderRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  maxTokens: number;
  tools?: ChatCompletionCreateParams['tools'];
  signal?: AbortSignal;
}

export interface CreateProviderOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
}

export interface ProviderInstance<TClient = unknown> {
  id: string;
  kind: ProviderKind;
  client: TClient;
  streamChatCompletion(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamEvent>>;
  isAbortError(error: unknown): boolean;
}