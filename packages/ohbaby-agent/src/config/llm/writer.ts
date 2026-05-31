import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getModelJsonPath } from "./loaders.js";
import type { InterfaceProviderKind, ModelJsonConfig } from "./types.js";
import { ConfigError } from "./types.js";
import { validateModelJson } from "./validation.js";
import { setEnvFileValue } from "./env-file.js";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_INTERFACE_PROVIDER: InterfaceProviderKind = "openai-compatible";

export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly contextWindowTokens?: number;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface SetActiveLLMConfigResult {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
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
  return {
    temperature:
      input.temperature ?? existingParams?.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens:
      input.maxTokens ?? existingParams?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...((input.contextWindowTokens ?? existingParams?.contextWindowTokens) ===
    undefined
      ? {}
      : {
          contextWindowTokens:
            input.contextWindowTokens ?? existingParams?.contextWindowTokens,
        }),
  };
}

function buildModelJson(
  input: SetActiveLLMConfigInput,
  existing: ModelJsonConfig | undefined,
): ModelJsonConfig {
  const models = existing?.models;
  return {
    provider: input.provider,
    defaultModel: input.model,
    apiConfig: {
      baseUrl: input.baseUrl,
      apiKeyEnv: input.apiKeyEnv,
      interfaceProvider: input.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
    },
    llmParams: buildLLMParams(input, existing),
    ...(models === undefined ? {} : { models }),
  };
}

async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}

async function writeEnvValue(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(
        `Failed to read .env file: ${(error as Error).message}`,
        "LOAD_FAILED",
        { path: envPath, cause: error },
      );
    }
  }

  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, setEnvFileValue(content, key, value), "utf-8");
}

export async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
): Promise<SetActiveLLMConfigResult> {
  const modelJsonPath = input.modelJsonPath ?? getModelJsonPath();
  const envPath =
    input.envPath ??
    (input.apiKey === undefined ? undefined : path.join(process.cwd(), ".env"));
  const existing = await readExistingModelJson(modelJsonPath);
  const modelJson = buildModelJson(input, existing);

  validateModelJson(modelJson);
  await writeFileAtomically(
    modelJsonPath,
    `${JSON.stringify(modelJson, null, 2)}\n`,
  );

  if (input.apiKey !== undefined && envPath !== undefined) {
    await writeEnvValue(envPath, input.apiKeyEnv, input.apiKey);
  }

  return {
    provider: modelJson.provider,
    model: modelJson.defaultModel,
    baseUrl: modelJson.apiConfig.baseUrl,
    apiKeyEnv: modelJson.apiConfig.apiKeyEnv,
    interfaceProvider:
      modelJson.apiConfig.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
    modelJsonPath,
    ...(envPath === undefined ? {} : { envPath }),
  };
}
