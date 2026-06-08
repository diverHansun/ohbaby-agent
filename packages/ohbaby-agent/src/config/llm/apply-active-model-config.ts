import * as path from "node:path";
import { createModelProfileRegistry } from "../../services/llm-model/modelProfiles.js";
import type { InterfaceProviderKind } from "./types.js";
import { ConfigError } from "./types.js";
import { loadEnvFile } from "./loaders.js";
import { reloadLLMConfig, setActiveLLMConfig } from "./index.js";

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INTERFACE_PROVIDER_KINDS = new Set<InterfaceProviderKind>([
  "openai-compatible",
  "anthropic",
]);

export interface ApplyActiveModelConfigInput {
  readonly provider?: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly projectRoot: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface ApplyActiveModelConfigResult {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly modelJsonPath: string;
  readonly envPath: string;
  readonly saved: true;
}

export async function applyActiveModelConfig(
  input: ApplyActiveModelConfigInput,
): Promise<ApplyActiveModelConfigResult> {
  const provider = requireNonEmpty(input.provider, "Provider required");
  const model = requireNonEmpty(input.model, "Model name required");
  const baseUrl = validateBaseUrl(input.baseUrl);
  const apiKeyEnv = validateApiKeyEnv(input.apiKeyEnv);
  const interfaceProvider = validateInterfaceProvider(input.interfaceProvider);
  const contextWindowTokens = validateOptionalPositiveInteger(
    input.contextWindowTokens,
    "Context window must be a positive integer",
  );
  const maxOutputTokens = validateOptionalPositiveInteger(
    input.maxOutputTokens,
    "Max output tokens must be a positive integer",
  );
  const envPath = input.envPath ?? path.join(input.projectRoot, ".env");

  await validateApiKeyAvailable({
    apiKey: input.apiKey,
    apiKeyEnv,
    envPath,
  });

  const profile = createModelProfileRegistry({
    defaultProvider: provider,
  }).resolve(model, provider);
  const resolvedContextWindowTokens =
    contextWindowTokens ?? (profile.source === "fallback" ? undefined : profile.contextWindowTokens);
  const resolvedMaxOutputTokens =
    maxOutputTokens ?? (profile.source === "fallback" ? undefined : profile.maxOutputTokens);

  const writeResult = await setActiveLLMConfig({
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    interfaceProvider,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(resolvedContextWindowTokens === undefined
      ? { clearContextWindowTokens: true }
      : { contextWindowTokens: resolvedContextWindowTokens }),
    clearActiveModelProfile: resolvedContextWindowTokens === undefined,
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: resolvedMaxOutputTokens,
          maxTokens: resolvedMaxOutputTokens,
        }),
    updateActiveModelProfile: resolvedContextWindowTokens !== undefined,
    ...(input.modelJsonPath === undefined
      ? {}
      : { modelJsonPath: input.modelJsonPath }),
    envPath,
  });

  if (input.apiKey !== undefined) {
    process.env[apiKeyEnv] = input.apiKey;
  }

  await reloadLLMConfig({
    envPath,
    modelJsonPath: writeResult.modelJsonPath,
    projectDirectory: input.projectRoot,
  });

  return {
    provider,
    baseUrl,
    interfaceProvider,
    apiKeyEnv,
    model,
    ...(resolvedContextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: resolvedContextWindowTokens }),
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: resolvedMaxOutputTokens }),
    modelJsonPath: writeResult.modelJsonPath,
    envPath,
    saved: true,
  };
}

function requireNonEmpty(value: string | undefined, message: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    throw new ConfigError(message, "INVALID_FIELD");
  }
  return trimmed;
}

function validateBaseUrl(value: string): string {
  const trimmed = requireNonEmpty(value, "Invalid base URL");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ConfigError("Invalid base URL", "INVALID_FIELD", {
      baseUrl: value,
    });
  }
  return trimmed.replace(/\/+$/u, "");
}

function validateApiKeyEnv(value: string): string {
  const trimmed = requireNonEmpty(value, "Invalid API key env");
  if (!ENV_VAR_NAME_PATTERN.test(trimmed)) {
    throw new ConfigError("Invalid API key env", "INVALID_FIELD", {
      apiKeyEnv: value,
    });
  }
  return trimmed;
}

function validateInterfaceProvider(
  value: InterfaceProviderKind,
): InterfaceProviderKind {
  if (!INTERFACE_PROVIDER_KINDS.has(value)) {
    throw new ConfigError("Invalid interface provider", "INVALID_FIELD", {
      interfaceProvider: value,
    });
  }
  return value;
}

function validateOptionalPositiveInteger(
  value: number | undefined,
  message: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(message, "INVALID_MAX_TOKENS", { value });
  }
  return value;
}

async function validateApiKeyAvailable(input: {
  readonly apiKey?: string;
  readonly apiKeyEnv: string;
  readonly envPath: string;
}): Promise<void> {
  if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
    return;
  }
  const envFile: Partial<Record<string, string>> = await loadEnvFile(
    input.envPath,
  );
  const existing = process.env[input.apiKeyEnv] ?? envFile[input.apiKeyEnv];
  if (existing === undefined || existing.trim() === "") {
    throw new ConfigError("API key required", "MISSING_API_KEY", {
      apiKeyEnv: input.apiKeyEnv,
    });
  }
}
