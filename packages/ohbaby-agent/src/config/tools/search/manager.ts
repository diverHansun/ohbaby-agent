import { resolveSearchJsonPath, loadSearchJson } from "./loaders.js";
import { validateApiKey, validateSearchJson } from "./validation.js";
import type { SearchConfig, SearchConfigLoadOptions } from "./types.js";
import { loadEnvFile } from "../../llm/loaders.js";
import { getGlobalEnvPath } from "../../../utils/project-env.js";
import { runtimeEnvValue } from "../../../utils/managed-runtime-env.js";

interface CachedSearchConfig {
  readonly config: SearchConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly searchJsonPath: string;
}

export class SearchConfigManager {
  private static instance: SearchConfigManager | null = null;
  private cachedConfig: CachedSearchConfig | null = null;

  private constructor() {
    // Use getInstance() to preserve singleton semantics.
  }

  static getInstance(): SearchConfigManager {
    SearchConfigManager.instance ??= new SearchConfigManager();
    return SearchConfigManager.instance;
  }

  static resetInstance(): void {
    SearchConfigManager.instance = null;
  }

  async load(options: SearchConfigLoadOptions = {}): Promise<SearchConfig> {
    const env = options.env ?? process.env;
    const searchJsonPath = await resolveSearchJsonPath(options.searchJsonPath);
    if (
      this.cachedConfig?.searchJsonPath === searchJsonPath &&
      this.cachedConfig.env === env
    ) {
      return this.cachedConfig.config;
    }

    return this.performLoad(env, searchJsonPath);
  }

  async reload(options: SearchConfigLoadOptions = {}): Promise<SearchConfig> {
    this.cachedConfig = null;
    return this.performLoad(
      options.env ?? process.env,
      await resolveSearchJsonPath(options.searchJsonPath),
    );
  }

  isCached(): boolean {
    return this.cachedConfig !== null;
  }

  private async performLoad(
    env: NodeJS.ProcessEnv,
    searchJsonPath: string,
  ): Promise<SearchConfig> {
    const rawConfig = await loadSearchJson(searchJsonPath);
    const searchJson = validateSearchJson(rawConfig ?? {}, searchJsonPath);
    const explicitValue = runtimeEnvValue(searchJson.apiKeyEnv, env);
    const fileValues =
      explicitValue === undefined && env === process.env
        ? await loadEnvFile(getGlobalEnvPath())
        : {};
    const apiKey = validateApiKey(
      {
        ...env,
        [searchJson.apiKeyEnv]:
          explicitValue ?? fileValues[searchJson.apiKeyEnv],
      },
      searchJson.apiKeyEnv,
    );
    const config: SearchConfig = {
      apiKey,
      apiKeyEnvName: searchJson.apiKeyEnv,
      ...(searchJson.baseUrl === undefined
        ? {}
        : { baseUrl: searchJson.baseUrl }),
      defaults: searchJson.defaults,
      provider: searchJson.provider,
    };

    this.cachedConfig = { config, env, searchJsonPath };
    return config;
  }
}
