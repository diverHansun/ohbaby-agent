import * as fs from "node:fs/promises";
import { getModelJsonPath } from "./loaders.js";
import type { InterfaceProviderKind, ModelJsonConfig } from "./types.js";
import { ConfigError } from "./types.js";
import { validateModelJson } from "./validation.js";
import { writeFileAtomically } from "../secrets/atomic-file.js";
import { writeEnvSecret } from "../secrets/env-secrets.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import { defaultApiKeyEnvForProvider, nonEmptyApiKey } from "./api-key.js";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_INTERFACE_PROVIDER: InterfaceProviderKind = "openai-compatible";

export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly contextWindowTokens?: number;
  readonly clearContextWindowTokens?: boolean;
  readonly clearActiveModelProfile?: boolean;
  readonly maxOutputTokens?: number;
  readonly updateActiveModelProfile?: boolean;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface SetActiveLLMConfigResult {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly modelJsonPath: string;
  readonly envPath?: string;
}

async function readExistingModelJson(
  modelJsonPath: string,
): Promise<ModelJsonConfig | undefined> {
  let content: string;
  try {
    content = await fs.readFile(modelJsonPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(
      `Failed to read existing model.json: ${(error as Error).message}`,
      "LOAD_FAILED",
      { path: modelJsonPath, cause: error },
    );
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    validateModelJson(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(
      `Invalid JSON in existing model.json: ${(error as Error).message}`,
      "INVALID_JSON",
      { path: modelJsonPath, cause: error },
    );
  }
}

function buildLLMParams(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig["llmParams"] {
  const existingParams = existing?.llmParams;
  const contextWindowTokens = input.clearContextWindowTokens
    ? undefined
    : (input.contextWindowTokens ?? existingParams?.contextWindowTokens);
  return {
    temperature:
      input.temperature ?? existingParams?.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens:
      input.maxTokens ?? existingParams?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(contextWindowTokens === undefined
      ? {}
      : {
          contextWindowTokens,
        }),
  };
}

function modelProfileKey(input: {
  readonly provider?: string;
  readonly model: string;
}): string {
  return `${input.provider ?? ""}\u0000${input.model}`.toLowerCase();
}

function buildModelProfiles(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig["models"] {
  const existingModels = existing?.models;
  const retained =
    existingModels?.filter(
      (profile) =>
        modelProfileKey(profile) !==
        modelProfileKey({ provider: input.provider, model: input.model }),
    ) ?? [];
  if (input.clearActiveModelProfile || input.clearContextWindowTokens) {
    return retained.length === 0 ? undefined : retained;
  }
  if (!input.updateActiveModelProfile) {
    return existingModels;
  }
  if (input.contextWindowTokens === undefined) {
    return existingModels;
  }

  const activeProfile = {
    provider: input.provider,
    model: input.model,
    contextWindowTokens: input.contextWindowTokens,
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
  };
  const activeKey = modelProfileKey(activeProfile);
  const retainedForActive =
    existingModels?.filter(
      (profile) => modelProfileKey(profile) !== activeKey,
    ) ?? [];
  return [...retainedForActive, activeProfile];
}

function buildModelJson(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig {
  const models = buildModelProfiles(input, existing);
  return {
    provider: input.provider,
    defaultModel: input.model,
    apiConfig: {
      baseUrl: input.baseUrl,
      ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
      interfaceProvider: input.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
    },
    llmParams: buildLLMParams(input, existing),
    ...(models === undefined ? {} : { models }),
  };
}

export async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
): Promise<SetActiveLLMConfigResult> {
  const modelJsonPath = input.modelJsonPath ?? getModelJsonPath();
  const explicitApiKey = nonEmptyApiKey(input.apiKey);
  const apiKeyEnv =
    input.apiKeyEnv ??
    (explicitApiKey === undefined
      ? undefined
      : defaultApiKeyEnvForProvider(input.provider));
  const normalizedInput =
    apiKeyEnv === undefined ? input : { ...input, apiKeyEnv };
  const envPath =
    input.envPath ??
    (explicitApiKey === undefined ? undefined : getGlobalEnvPath());
  const existing = await readExistingModelJson(modelJsonPath);
  const modelJson = buildModelJson(normalizedInput, existing);

  validateModelJson(modelJson);
  await writeFileAtomically(
    modelJsonPath,
    `${JSON.stringify(modelJson, null, 2)}\n`,
  );

  if (
    explicitApiKey !== undefined &&
    envPath !== undefined &&
    apiKeyEnv !== undefined
  ) {
    await writeEnvSecret(envPath, apiKeyEnv, explicitApiKey);
  }

  return {
    provider: modelJson.provider,
    model: modelJson.defaultModel,
    baseUrl: modelJson.apiConfig.baseUrl,
    ...(modelJson.apiConfig.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnv: modelJson.apiConfig.apiKeyEnv }),
    interfaceProvider:
      modelJson.apiConfig.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
    modelJsonPath,
    ...(envPath === undefined ? {} : { envPath }),
  };
}
