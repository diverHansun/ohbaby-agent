import { SearchConfigManager } from "./manager.js";
import type { SearchConfig, SearchConfigLoadOptions } from "./types.js";
import type { SearchProviderConfig } from "../../../services/search-providers/index.js";

export type {
  SearchConfig,
  SearchConfigErrorCode,
  SearchConfigLoadOptions,
  SearchJsonConfig,
} from "./types.js";
export { SearchConfigError } from "./types.js";
export { getSearchJsonPath, loadSearchJson } from "./loaders.js";
export { validateApiKey, validateSearchJson } from "./validation.js";
export {
  setSearchApiKey,
  type SetSearchApiKeyInput,
  type SetSearchApiKeyResult,
} from "./writer.js";

export async function getSearchConfig(
  options: SearchConfigLoadOptions = {},
): Promise<SearchConfig> {
  return SearchConfigManager.getInstance().load(options);
}

export async function reloadSearchConfig(
  options: SearchConfigLoadOptions = {},
): Promise<SearchConfig> {
  return SearchConfigManager.getInstance().reload(options);
}

export function isSearchConfigCached(): boolean {
  return SearchConfigManager.getInstance().isCached();
}

export function toSearchProviderConfig(
  config: SearchConfig,
): SearchProviderConfig {
  return {
    apiKey: config.apiKey,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    defaults: {
      search: config.defaults,
    },
    providerId: config.provider,
  };
}

export { SearchConfigManager as _SearchConfigManager } from "./manager.js";
