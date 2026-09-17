export type UiConnectModelInterfaceProvider =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic";
export type UiCurrentModelInterfaceProvider = UiConnectModelInterfaceProvider;

export function isConnectModelInterfaceProvider(
  value: unknown,
): value is UiConnectModelInterfaceProvider {
  return (
    value === "openai-compatible" ||
    value === "openai-responses" ||
    value === "anthropic"
  );
}

export interface UiConnectModelInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiConnectModelResult {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv?: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly contextWindowSource: "detected" | "user" | "default";
  readonly maxOutputTokens?: number;
  readonly modelJsonPath: string;
  readonly envPath: string;
  readonly saved: true;
  readonly warning?: string;
}

export interface UiCurrentModelConfig {
  readonly reasoning?: UiReasoningCapabilityView;
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiCurrentModelInterfaceProvider;
  readonly apiKeyEnv?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiProbeModelContextWindowInput {
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiProbeModelContextWindowResult {
  readonly reasoning?: UiReasoningCapabilityView;
  readonly contextWindowTokens: number;
  readonly contextWindowSource: "detected" | "user" | "default";
  readonly warning?: string;
}

export function inferConnectModelInterfaceProvider(
  baseUrl: string,
): UiConnectModelInterfaceProvider {
  const lower = baseUrl.toLowerCase();
  return lower.includes("anthropic") ||
    lower.includes("/api/anthropic") ||
    lower.endsWith("/anthropic") ||
    lower.includes("/v1/messages")
    ? "anthropic"
    : "openai-compatible";
}

/** Persisted preference; omitted fields select the current confirmed default. */
export interface UiReasoningConfig {
  readonly enabled?: boolean;
  readonly effort?: string;
}
/** Sanitized public evidence. Protocol mapping and credentials are private. */
export interface UiReasoningCapabilityView {
  readonly status: (typeof UI_REASONING_STATUSES)[number];
  readonly mode?: "none" | "binary" | "effort";
  readonly supportsDisabled?: boolean;
  readonly efforts: readonly string[];
  readonly default?: UiReasoningConfig;
  readonly source?: string;
  readonly reason?: string;
  readonly stale?: boolean;
}

export const UI_REASONING_STATUSES = [
  "detecting",
  "identified",
  "unknown",
] as const;
export function isUiReasoningConfig(
  value: unknown,
): value is UiReasoningConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "enabled" || key === "effort") &&
    (record.enabled === undefined || typeof record.enabled === "boolean") &&
    (record.effort === undefined ||
      (typeof record.effort === "string" &&
        record.effort.trim() !== "" &&
        !["none", "off", "disabled"].includes(record.effort.toLowerCase())))
  );
}
