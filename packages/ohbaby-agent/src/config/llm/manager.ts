import { runtimeEnvValue } from "../../utils/managed-runtime-env.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import {
  coordinateModelConfig,
  assertModelConfigConsistent,
} from "./config-coordination.js";
import { inferConnectModelInterfaceProvider } from "ohbaby-sdk";
/**
 * LLM Configuration Manager.
 * Coordinates loading, validation, caching, and hot-reload.
 */

import type { LLMConfig } from "ohbaby-llm";
import { ConfigError } from "ohbaby-llm";
import { loadApiKey, loadEnvFile } from "./loaders.js";
import { loadProjectedModelJson } from "./model-document.js";
import {
  firstNonEmptyApiKey,
  OPTIONAL_API_KEY_PLACEHOLDER,
} from "./api-key.js";
import {
  setActiveLLMConfig as writeActiveLLMConfig,
  type SetActiveLLMConfigInput,
  type SetActiveLLMConfigResult,
} from "./writer.js";

export interface LLMConfigLoadOptions {
  readonly projectDirectory?: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface CachedLLMConfig {
  readonly config: LLMConfig;
  readonly projectDirectory: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Singleton manager for LLM configuration.
 * Provides caching and hot-reload capabilities.
 */
class LLMConfigManager {
  private static instance: LLMConfigManager | null = null;
  private cachedConfig: CachedLLMConfig | null = null;
  private lastError: ConfigError | null = null;

  private constructor() {
    // Use getInstance() to preserve singleton semantics.
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): LLMConfigManager {
    LLMConfigManager.instance ??= new LLMConfigManager();
    return LLMConfigManager.instance;
  }

  /**
   * Reset the singleton instance.
   * Primarily used for testing purposes.
   */
  static resetInstance(): void {
    LLMConfigManager.instance = null;
  }

  /**
   * Load LLM configuration.
   * Returns cached config if available, otherwise loads from file.
   *
   * @throws {ConfigError} If configuration is invalid or missing
   */
  async load(options: LLMConfigLoadOptions = {}): Promise<LLMConfig> {
    return coordinateModelConfig(options.modelJsonPath, () =>
      this.loadCoordinated(options),
    );
  }

  private async loadCoordinated(
    options: LLMConfigLoadOptions,
  ): Promise<LLMConfig> {
    assertModelConfigConsistent(options.modelJsonPath);
    const resolvedOptions = this.resolveOptions(options);
    if (
      this.cachedConfig?.projectDirectory ===
        resolvedOptions.projectDirectory &&
      this.cachedConfig.modelJsonPath === resolvedOptions.modelJsonPath &&
      this.cachedConfig.envPath === resolvedOptions.envPath &&
      this.cachedConfig.env === resolvedOptions.env
    ) {
      return this.cachedConfig.config;
    }

    return this.performLoad(resolvedOptions);
  }

  /**
   * Reload configuration from file.
   * Clears cache and forces a fresh load.
   *
   * @throws {ConfigError} If configuration is invalid or missing
   */
  async reload(options: LLMConfigLoadOptions = {}): Promise<LLMConfig> {
    return coordinateModelConfig(options.modelJsonPath, async () => {
      assertModelConfigConsistent(options.modelJsonPath);
      this.cachedConfig = null;
      this.lastError = null;
      return this.performLoad(this.resolveOptions(options));
    });
  }

  async setActive(
    input: SetActiveLLMConfigInput,
  ): Promise<SetActiveLLMConfigResult> {
    const result = await writeActiveLLMConfig(input);
    this.cachedConfig = null;
    this.lastError = null;
    return result;
  }

  /** A completed settings write invalidates cached clients for the next load. */
  invalidate(): void {
    this.cachedConfig = null;
    this.lastError = null;
  }

  /** Last loading error, cleared after a successful load or settings write. */
  getLastError(): ConfigError | null {
    return this.lastError;
  }

  /**
   * Check if configuration is currently cached.
   */
  isCached(): boolean {
    return this.cachedConfig !== null;
  }

  /**
   * Perform the actual configuration loading.
   */
  private resolveOptions(
    options: LLMConfigLoadOptions,
  ): Required<Pick<LLMConfigLoadOptions, "projectDirectory" | "env">> &
    Pick<LLMConfigLoadOptions, "modelJsonPath" | "envPath"> {
    return {
      projectDirectory: options.projectDirectory ?? process.cwd(),
      env: options.env ?? process.env,
      ...(options.modelJsonPath === undefined
        ? {}
        : { modelJsonPath: options.modelJsonPath }),
      ...(options.envPath === undefined ? {} : { envPath: options.envPath }),
    };
  }

  private async performLoad(
    options: Required<Pick<LLMConfigLoadOptions, "projectDirectory" | "env">> &
      Pick<LLMConfigLoadOptions, "modelJsonPath" | "envPath">,
  ): Promise<LLMConfig> {
    try {
      const modelJson = await loadProjectedModelJson({
        ...(options.modelJsonPath === undefined
          ? {}
          : { modelJsonPath: options.modelJsonPath }),
      });

      // Load API key from environment when configured.
      const apiKeyEnvName = modelJson.apiConfig.apiKeyEnv;
      const envFileValues =
        apiKeyEnvName === undefined
          ? {}
          : {
              ...(runtimeEnvValue(apiKeyEnvName, options.env) === undefined
                ? await loadEnvFile(getGlobalEnvPath())
                : {}),
              ...(options.envPath === undefined
                ? {}
                : await loadEnvFile(options.envPath)),
            };
      const apiKey =
        apiKeyEnvName === undefined
          ? OPTIONAL_API_KEY_PLACEHOLDER
          : (loadConfiguredApiKey(apiKeyEnvName, options.env, envFileValues) ??
            OPTIONAL_API_KEY_PLACEHOLDER);

      // Build final config
      const modelProfiles = modelJson.models;
      const config: LLMConfig = {
        provider: modelJson.provider,
        model: modelJson.defaultModel,
        apiKey: apiKey,
        ...(apiKeyEnvName === undefined ? {} : { apiKeyEnv: apiKeyEnvName }),
        baseUrl: modelJson.apiConfig.baseUrl,
        interfaceProvider:
          modelJson.apiConfig.interfaceProvider ??
          inferConnectModelInterfaceProvider(modelJson.apiConfig.baseUrl),
        promptCache: modelJson.apiConfig.promptCache ?? "auto",
        ...(modelJson.llmParams.reasoning === undefined
          ? {}
          : { reasoning: { ...modelJson.llmParams.reasoning } }),
        maxTokens: modelJson.llmParams.maxTokens,
        ...(modelJson.llmParams.contextWindowTokens === undefined
          ? {}
          : {
              contextWindowTokens: modelJson.llmParams.contextWindowTokens,
            }),
        ...(modelProfiles === undefined ? {} : { modelProfiles }),
      };

      // Cache and return
      this.cachedConfig = {
        config,
        projectDirectory: options.projectDirectory,
        ...(options.modelJsonPath === undefined
          ? {}
          : { modelJsonPath: options.modelJsonPath }),
        ...(options.envPath === undefined ? {} : { envPath: options.envPath }),
        env: options.env,
      };
      this.lastError = null;
      return config;
    } catch (error) {
      // Wrap non-ConfigError errors
      const configError =
        error instanceof ConfigError
          ? error
          : new ConfigError(
              `Failed to load LLM configuration: ${(error as Error).message}`,
              "LOAD_FAILED",
              { cause: error },
            );

      this.lastError = configError;
      throw configError;
    }
  }
}

function loadConfiguredApiKey(
  envVarName: string,
  env: NodeJS.ProcessEnv,
  envFileValues: Record<string, string>,
): string | undefined {
  const effectiveEnv =
    runtimeEnvValue(envVarName, env) === env[envVarName]
      ? env
      : { ...env, [envVarName]: undefined };
  const envValue = firstNonEmptyApiKey(loadApiKey(envVarName, effectiveEnv));
  if (envValue !== undefined) {
    return envValue;
  }
  return firstNonEmptyApiKey(loadApiKey(envVarName, envFileValues));
}

export { LLMConfigManager };
