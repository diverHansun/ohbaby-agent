/**
 * Validation functions for LLM configuration.
 * All functions are pure and stateless.
 */

import { ConfigError } from "./types.js";
import type { InterfaceProviderKind, ModelJsonConfig } from "./types.js";

const ENDPOINT_PATHS = ["/chat/completions", "/messages", "/responses"];
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INTERFACE_PROVIDER_KINDS = new Set<InterfaceProviderKind>([
  "openai-compatible",
  "anthropic",
]);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function formatInvalidValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function validateBaseUrlValue(baseUrl: string): void {
  const normalized = trimTrailingSlashes(baseUrl.trim()).toLowerCase();

  for (const endpointPath of ENDPOINT_PATHS) {
    if (normalized.endsWith(endpointPath)) {
      throw new ConfigError(
        `Invalid apiConfig.baseUrl: use the SDK base URL without '${endpointPath}'. For OpenAI-compatible providers, the SDK appends the chat completions path automatically.`,
        "INVALID_FIELD",
        { baseUrl, endpointPath },
      );
    }
  }
}

function validateInterfaceProviderValue(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value !== "string" ||
    !INTERFACE_PROVIDER_KINDS.has(value as InterfaceProviderKind)
  ) {
    throw new ConfigError(
      `Invalid apiConfig.interfaceProvider: ${formatInvalidValue(
        value,
      )}. Must be 'openai-compatible' or 'anthropic'`,
      "INVALID_FIELD",
      { value },
    );
  }
}

function validateApiKeyEnvValue(value: string): void {
  if (!ENV_VAR_NAME_PATTERN.test(value)) {
    throw new ConfigError(
      `Invalid apiConfig.apiKeyEnv: ${formatInvalidValue(
        value,
      )}. Must be a valid environment variable name`,
      "INVALID_FIELD",
      { value },
    );
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && value > 0 && Number.isInteger(value);
}

function validateModelProfile(profile: unknown, index: number): void {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new ConfigError(
      `Invalid models[${String(index)}]: expected an object`,
      "INVALID_FIELD",
      { index, value: profile },
    );
  }

  const record = profile as Record<string, unknown>;
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new ConfigError(
      `Invalid models[${String(index)}].id: expected a string`,
      "INVALID_FIELD",
      { index, value: record.id },
    );
  }
  if (record.provider !== undefined && typeof record.provider !== "string") {
    throw new ConfigError(
      `Invalid models[${String(index)}].provider: expected a string`,
      "INVALID_FIELD",
      { index, value: record.provider },
    );
  }
  if (typeof record.model !== "string" || record.model.trim() === "") {
    throw new ConfigError(
      `Invalid models[${String(index)}].model: expected a non-empty string`,
      "INVALID_FIELD",
      { index, value: record.model },
    );
  }
  if (record.label !== undefined && typeof record.label !== "string") {
    throw new ConfigError(
      `Invalid models[${String(index)}].label: expected a string`,
      "INVALID_FIELD",
      { index, value: record.label },
    );
  }
  if (!isPositiveInteger(record.contextWindowTokens)) {
    throw new ConfigError(
      `Invalid models[${String(
        index,
      )}].contextWindowTokens: ${formatInvalidValue(
        record.contextWindowTokens,
      )}. Must be a positive integer`,
      "INVALID_MAX_TOKENS",
      { index, value: record.contextWindowTokens },
    );
  }
  if (
    record.maxOutputTokens !== undefined &&
    !isPositiveInteger(record.maxOutputTokens)
  ) {
    throw new ConfigError(
      `Invalid models[${String(index)}].maxOutputTokens: ${formatInvalidValue(
        record.maxOutputTokens,
      )}. Must be a positive integer`,
      "INVALID_MAX_TOKENS",
      { index, value: record.maxOutputTokens },
    );
  }
}

/**
 * Validate the structure and values of ModelJsonConfig.
 * Throws ConfigError if validation fails.
 */
export function validateModelJson(
  config: unknown,
): asserts config is ModelJsonConfig {
  if (!config || typeof config !== "object") {
    throw new ConfigError(
      "Invalid model.json: expected an object",
      "INVALID_JSON",
    );
  }

  const obj = config as Record<string, unknown>;
  const errors: string[] = [];

  // Validate required top-level fields
  if (!obj.provider || typeof obj.provider !== "string") {
    errors.push("provider (string) is required");
  }

  if (!obj.defaultModel || typeof obj.defaultModel !== "string") {
    errors.push("defaultModel (string) is required");
  }

  // Validate apiConfig
  if (!obj.apiConfig || typeof obj.apiConfig !== "object") {
    errors.push("apiConfig (object) is required");
  } else {
    const apiConfig = obj.apiConfig as Record<string, unknown>;

    if (!apiConfig.baseUrl || typeof apiConfig.baseUrl !== "string") {
      errors.push("apiConfig.baseUrl (string) is required");
    } else {
      validateBaseUrlValue(apiConfig.baseUrl);
    }

    if (apiConfig.apiKeyEnv !== undefined) {
      if (typeof apiConfig.apiKeyEnv !== "string") {
        errors.push("apiConfig.apiKeyEnv must be a string when provided");
      } else if (apiConfig.apiKeyEnv.trim() === "") {
        throw new ConfigError(
          `Invalid apiConfig.apiKeyEnv: ${formatInvalidValue(apiConfig.apiKeyEnv)}. Must be a valid environment variable name`,
          "INVALID_FIELD",
          { value: apiConfig.apiKeyEnv },
        );
      } else {
        validateApiKeyEnvValue(apiConfig.apiKeyEnv);
      }
    }

    validateInterfaceProviderValue(apiConfig.interfaceProvider);
  }

  // Validate llmParams
  if (!obj.llmParams || typeof obj.llmParams !== "object") {
    errors.push("llmParams (object) is required");
  } else {
    const llmParams = obj.llmParams as Record<string, unknown>;

    if (typeof llmParams.temperature !== "number") {
      errors.push("llmParams.temperature (number) is required");
    } else if (llmParams.temperature < 0 || llmParams.temperature > 2) {
      throw new ConfigError(
        `Invalid temperature: ${String(llmParams.temperature)}. Must be between 0 and 2`,
        "INVALID_TEMPERATURE",
        { value: llmParams.temperature },
      );
    }

    if (typeof llmParams.maxTokens !== "number") {
      errors.push("llmParams.maxTokens (number) is required");
    } else if (
      llmParams.maxTokens <= 0 ||
      !Number.isInteger(llmParams.maxTokens)
    ) {
      throw new ConfigError(
        `Invalid maxTokens: ${String(llmParams.maxTokens)}. Must be a positive integer`,
        "INVALID_MAX_TOKENS",
        { value: llmParams.maxTokens },
      );
    }

    if (
      llmParams.contextWindowTokens !== undefined &&
      (typeof llmParams.contextWindowTokens !== "number" ||
        llmParams.contextWindowTokens <= 0 ||
        !Number.isInteger(llmParams.contextWindowTokens))
    ) {
      throw new ConfigError(
        `Invalid contextWindowTokens: ${formatInvalidValue(
          llmParams.contextWindowTokens,
        )}. Must be a positive integer`,
        "INVALID_MAX_TOKENS",
        { value: llmParams.contextWindowTokens },
      );
    }
  }

  if (obj.models !== undefined) {
    if (!Array.isArray(obj.models)) {
      throw new ConfigError(
        "Invalid models: expected an array",
        "INVALID_FIELD",
        { value: obj.models },
      );
    }
    obj.models.forEach(validateModelProfile);
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `Invalid model.json: ${errors.join("; ")}`,
      "MISSING_FIELD",
      { missingFields: errors },
    );
  }
}
