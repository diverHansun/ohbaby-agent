import { getSearchJsonPath, loadSearchJson } from "./loaders.js";
import { validateApiKey, validateSearchJson } from "./validation.js";
import type { SearchConfig, SearchConfigLoadOptions } from "./types.js";

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
    const searchJsonPath = options.searchJsonPath ?? getSearchJsonPath();
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
      options.searchJsonPath ?? getSearchJsonPath(),
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
    const apiKey = validateApiKey(env, searchJson.apiKeyEnv);
    const config: SearchConfig = {
      apiKey,
      apiKeyEnvName: searchJson.apiKeyEnv,
      ...(searchJson.baseUrl === undefined ? {} : { baseUrl: searchJson.baseUrl }),
      defaults: searchJson.defaults,
      provider: searchJson.provider,
    };

    this.cachedConfig = { config, env, searchJsonPath };
    return config;
  }
}
