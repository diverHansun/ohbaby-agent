export type UiConnectModelInterfaceProvider = "openai-compatible" | "anthropic";

export interface UiConnectModelInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiConnectModelResult {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv: string;
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
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiProbeModelContextWindowInput {
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider: UiConnectModelInterfaceProvider;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiProbeModelContextWindowResult {
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
