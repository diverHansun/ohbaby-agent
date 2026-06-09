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
