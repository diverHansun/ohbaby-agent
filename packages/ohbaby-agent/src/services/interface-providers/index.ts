import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderInstance,
  InterfaceProviderKind,
} from "./types.js";

export type {
  CreateInterfaceProviderOptions,
  InputTokenBreakdown,
  InterfaceProviderFinishReason,
  InterfaceProviderFunctionTool,
  InterfaceProviderFunctionTools,
  InterfaceProviderInstance,
  InterfaceProviderKind,
  InterfaceProviderPromptCache,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  InterfaceProviderTokenUsage,
  InterfaceProviderToolCallDelta,
  LLMRequestPurpose,
  PromptCacheRequestStrategy,
} from "./types.js";

export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAICompatibleProvider } from "./openai-compatible.js";
export type {
  TokenUsageDiagnosticReporter,
  TokenUsageNormalizationDiagnostic,
} from "./token-usage.js";

export function resolveInterfaceProviderKind(
  interfaceProvider: InterfaceProviderKind | undefined,
): InterfaceProviderKind {
  return interfaceProvider ?? "openai-compatible";
}

export function createInterfaceProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance {
  const kind = resolveInterfaceProviderKind(options.interfaceProvider);

  switch (kind) {
    case "openai-compatible":
      return createOpenAICompatibleProvider(options);
    case "anthropic":
      return createAnthropicProvider(options);
    case "openai-responses":
      throw new Error(
        "OpenAI Responses interface provider is not implemented.",
      );
    default: {
      const unexpectedKind: never = kind;
      return rejectUnsupportedInterfaceProviderKind(unexpectedKind);
    }
  }
}

function rejectUnsupportedInterfaceProviderKind(kind: unknown): never {
  throw new Error(`Unsupported interface provider kind: ${String(kind)}`);
}
