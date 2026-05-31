import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type {
  CreateInterfaceProviderOptions,
  InterfaceProviderInstance,
  InterfaceProviderKind,
} from "./types.js";

export type {
  CreateInterfaceProviderOptions,
  InterfaceProviderFinishReason,
  InterfaceProviderInstance,
  InterfaceProviderKind,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  InterfaceProviderTokenUsage,
  InterfaceProviderToolCallDelta,
} from "./types.js";

export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAICompatibleProvider } from "./openai-compatible.js";

export function resolveInterfaceProviderKind(
  interfaceProvider: InterfaceProviderKind | undefined,
): InterfaceProviderKind {
  return interfaceProvider ?? "openai-compatible";
}

export function createInterfaceProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance {
  const kind = resolveInterfaceProviderKind(options.interfaceProvider);

  if (kind === "anthropic") {
    return createAnthropicProvider(options);
  }

  return createOpenAICompatibleProvider(options);
}
