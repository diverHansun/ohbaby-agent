import {
  ConfigError,
  resolveRequestReasoning,
  type ReasoningConfig,
  type ReasoningIntent,
  type ResolveRequestReasoningOptions,
} from "ohbaby-llm";

/** An explicit subagent choice replaces the entry preference as a unit. */
export function resolveSubagentReasoning(
  config: ResolveRequestReasoningOptions,
  preference: ReasoningConfig,
): ReasoningIntent {
  const resolved = resolveRequestReasoning({
    ...config,
    reasoning: preference,
  });
  if (resolved.mode === "service-default") {
    throw new ConfigError(
      "Reasoning capability is not identified. Use the model default.",
      "INVALID_FIELD",
    );
  }
  return resolved.intent;
}
