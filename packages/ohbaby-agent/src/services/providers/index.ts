import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import type { CreateProviderOptions, ProviderInstance, ProviderKind } from './types.js';

const ANTHROPIC_PROVIDER_IDS = new Set(['anthropic', 'claude']);

export type {
  CreateProviderOptions,
  ProviderFinishReason,
  ProviderInstance,
  ProviderKind,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderTokenUsage,
  ProviderToolCallDelta,
} from './types.js';

export { createAnthropicProvider } from './anthropic.js';
export { createOpenAICompatibleProvider } from './openai-compatible.js';

export function resolveProviderKind(provider: string): ProviderKind {
  return ANTHROPIC_PROVIDER_IDS.has(provider.toLowerCase())
    ? 'anthropic'
    : 'openai-compatible';
}

export function createProvider(options: CreateProviderOptions): ProviderInstance {
  const kind = resolveProviderKind(options.provider);

  if (kind === 'anthropic') {
    return createAnthropicProvider(options);
  }

  return createOpenAICompatibleProvider(options);
}