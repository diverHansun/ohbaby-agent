/** Creates a provider-backed client from validated configuration. */
import type { LLMConfig } from "../config/types.js";
import {
  createInterfaceProvider,
  type TokenUsageDiagnosticReporter,
} from "../providers/index.js";
import type { LLMClientInstance } from "./types.js";

export function createLLMClientFromConfig(
  config: LLMConfig,
  options: { readonly tokenUsageReporter?: TokenUsageDiagnosticReporter } = {},
): LLMClientInstance {
  // Create protocol-specific SDK adapter instance.
  const provider = createInterfaceProvider({
    id: config.provider,
    interfaceProvider: config.interfaceProvider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(options.tokenUsageReporter === undefined
      ? {}
      : { tokenUsageReporter: options.tokenUsageReporter }),
  });

  // Return configured client instance
  // Note: apiKey is intentionally excluded from the returned config for security
  return {
    provider,
    config: {
      provider: config.provider,
      model: config.model,
      ...(config.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: config.apiKeyEnv }),
      baseUrl: config.baseUrl,
      interfaceProvider: config.interfaceProvider,
      promptCache: config.promptCache,
      reasoning: config.reasoning,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      ...(config.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: config.contextWindowTokens }),
      ...(config.modelProfiles === undefined
        ? {}
        : { modelProfiles: config.modelProfiles }),
    },
  };
}
