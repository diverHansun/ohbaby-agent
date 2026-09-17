import { setManagedRuntimeEnv } from "../../utils/managed-runtime-env.js";
import {
  coordinateModelConfig,
  markModelConfigConsistent,
  markModelConfigInconsistent,
  readOptionalConfigFile,
} from "./config-coordination.js";
import * as fs from "node:fs/promises";
import { getModelJsonPath } from "./loaders.js";
import type {
  InterfaceProviderKind,
  ModelJsonConfig,
  PromptCachePolicy,
  ReasoningConfig,
} from "./types.js";
import { ConfigError } from "./types.js";
import { validateModelJson, validateReasoningConfig } from "./validation.js";
import { writeFileAtomically } from "../secrets/atomic-file.js";
import { writeEnvSecret } from "../secrets/env-secrets.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import { defaultApiKeyEnvForProvider, nonEmptyApiKey } from "./api-key.js";

import { modelProfileRouteKey } from "./model-profile.js";

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_INTERFACE_PROVIDER: InterfaceProviderKind = "openai-compatible";

export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly promptCache?: PromptCachePolicy;
  readonly temperature?: number;
  readonly reasoning?: ReasoningConfig;
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
  readonly promptCache: PromptCachePolicy;
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
  const temperature = input.temperature ?? existingParams?.temperature;
  const reasoning =
    existingParams?.reasoning === undefined && input.reasoning === undefined
      ? undefined
      : {
          ...existingParams?.reasoning,
          ...Object.fromEntries(
            Object.entries(input.reasoning ?? {}).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        };
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoning === undefined ? {} : { reasoning }),
    maxTokens:
      input.maxTokens ?? existingParams?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(contextWindowTokens === undefined
      ? {}
      : {
          contextWindowTokens,
        }),
  };
}

function buildModelProfiles(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig["models"] {
  const existingModels = existing?.models;
  const activeRoute = {
    ...input,
    interfaceProvider: input.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
  };
  const key = (profile: Parameters<typeof modelProfileRouteKey>[0]): string =>
    modelProfileRouteKey(profile, existing?.provider ?? input.provider);
  const retained =
    existingModels?.filter((profile) => key(profile) !== key(activeRoute)) ??
    [];
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
    ...existingModels
      ?.slice()
      .reverse()
      .find((profile) => key(profile) === key(activeRoute)),
    provider: input.provider,
    model: input.model,
    baseUrl: input.baseUrl,
    interfaceProvider: activeRoute.interfaceProvider,
    contextWindowTokens: input.contextWindowTokens,
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
  };
  const activeKey = key(activeProfile);
  const retainedForActive =
    existingModels?.filter((profile) => key(profile) !== activeKey) ?? [];
  return [...retainedForActive, activeProfile];
}

function buildModelJson(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig {
  const models = buildModelProfiles(input, existing);
  const promptCache = input.promptCache ?? existing?.apiConfig.promptCache;
  return {
    provider: input.provider,
    defaultModel: input.model,
    apiConfig: {
      baseUrl: input.baseUrl,
      ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
      interfaceProvider: input.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
      ...(promptCache === undefined ? {} : { promptCache }),
    },
    llmParams: buildLLMParams(input, existing),
    ...(models === undefined ? {} : { models }),
  };
}

export async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
): Promise<SetActiveLLMConfigResult> {
  return coordinateModelConfig(input.modelJsonPath, () =>
    writeActiveConfig(input),
  );
}

async function writeActiveConfig(
  input: SetActiveLLMConfigInput,
): Promise<SetActiveLLMConfigResult> {
  validateReasoningConfig(input.reasoning);
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
  const originalModel = await readOptionalConfigFile(modelJsonPath);
  const writesSecret =
    explicitApiKey !== undefined &&
    envPath !== undefined &&
    apiKeyEnv !== undefined;
  const originalEnv = writesSecret
    ? await readOptionalConfigFile(envPath)
    : undefined;
  try {
    await writeFileAtomically(
      modelJsonPath,
      `${JSON.stringify(modelJson, null, 2)}\n`,
    );
    if (writesSecret) await writeEnvSecret(envPath, apiKeyEnv, explicitApiKey);
  } catch (error) {
    try {
      if (originalModel === undefined)
        await fs.rm(modelJsonPath, { force: true });
      else await writeFileAtomically(modelJsonPath, originalModel);
      if (writesSecret) {
        if (originalEnv === undefined) await fs.rm(envPath, { force: true });
        else await writeFileAtomically(envPath, originalEnv);
      }
    } catch (rollbackError) {
      markModelConfigInconsistent(modelJsonPath);
      throw new Error(
        "Model configuration partially saved; rollback failed and new runs are blocked until configuration is repaired.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  markModelConfigConsistent(modelJsonPath);
  if (writesSecret) setManagedRuntimeEnv(apiKeyEnv, explicitApiKey);

  return {
    provider: modelJson.provider,
    model: modelJson.defaultModel,
    baseUrl: modelJson.apiConfig.baseUrl,
    ...(modelJson.apiConfig.apiKeyEnv === undefined
      ? {}
      : { apiKeyEnv: modelJson.apiConfig.apiKeyEnv }),
    interfaceProvider:
      modelJson.apiConfig.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
    promptCache: modelJson.apiConfig.promptCache ?? "auto",
    modelJsonPath,
    ...(envPath === undefined ? {} : { envPath }),
  };
}
