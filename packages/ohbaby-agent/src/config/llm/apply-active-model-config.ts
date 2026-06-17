import { createModelProfileRegistry } from "../../services/llm-model/modelProfiles.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import type { InterfaceProviderKind } from "./types.js";
import { ConfigError } from "./types.js";
import {
  probeContextWindow,
  type ContextWindowSource,
} from "./context-window-probe.js";
import { loadEnvFile } from "./loaders.js";
import { reloadLLMConfig, setActiveLLMConfig } from "./index.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
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
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly maxOutputTokens?: number;
  readonly modelJsonPath: string;
  readonly envPath: string;
  readonly saved: true;
  readonly warning?: string;
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
  const envPath = input.envPath ?? getGlobalEnvPath();

  const apiKey = await resolveApiKey({
    apiKey: input.apiKey,
    apiKeyEnv,
    envPath,
  });
  const probe = await probeContextWindow({
    apiKey,
    baseUrl,
    interfaceProvider,
    model,
  });
  const resolvedContextWindow = resolveContextWindow({
    detectedContextWindowTokens: probe.contextWindowTokens,
    probeWarning: probe.warning,
    userContextWindowTokens: contextWindowTokens,
  });

  const profile = createModelProfileRegistry({
    defaultProvider: provider,
  }).resolve(model, provider);
  const resolvedMaxOutputTokens =
    maxOutputTokens ??
    (profile.source === "fallback" ? undefined : profile.maxOutputTokens);

  const writeResult = await setActiveLLMConfig({
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    interfaceProvider,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: resolvedMaxOutputTokens,
          maxTokens: resolvedMaxOutputTokens,
        }),
    updateActiveModelProfile: true,
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
    contextWindowTokens: resolvedContextWindow.contextWindowTokens,
    contextWindowSource: resolvedContextWindow.contextWindowSource,
    ...(resolvedMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: resolvedMaxOutputTokens }),
    modelJsonPath: writeResult.modelJsonPath,
    envPath,
    saved: true,
    ...(resolvedContextWindow.warning === undefined
      ? {}
      : { warning: resolvedContextWindow.warning }),
  };
}

function resolveContextWindow(input: {
  readonly detectedContextWindowTokens?: number;
  readonly probeWarning?: string;
  readonly userContextWindowTokens?: number;
}): {
  readonly contextWindowTokens: number;
  readonly contextWindowSource: ContextWindowSource;
  readonly warning?: string;
} {
  if (input.detectedContextWindowTokens !== undefined) {
    return {
      contextWindowSource: "detected",
      contextWindowTokens: input.detectedContextWindowTokens,
    };
  }
  if (input.userContextWindowTokens !== undefined) {
    return {
      contextWindowSource: "user",
      contextWindowTokens: input.userContextWindowTokens,
      ...(input.probeWarning === undefined
        ? {}
        : { warning: input.probeWarning }),
    };
  }
  return {
    contextWindowSource: "default",
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    ...(input.probeWarning === undefined
      ? {}
      : { warning: input.probeWarning }),
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

async function resolveApiKey(input: {
  readonly apiKey?: string;
  readonly apiKeyEnv: string;
  readonly envPath: string;
}): Promise<string> {
  if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
    return input.apiKey;
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
  return existing;
}
