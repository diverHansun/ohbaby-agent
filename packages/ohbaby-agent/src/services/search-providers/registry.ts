import { createTavilyProvider } from "./tavily.js";
import {
  InvalidProviderConfigError,
  UnknownProviderError,
  type SearchProvider,
  type SearchProviderConfig,
  type SearchProviderFactory,
} from "./types.js";

const providerFactories = new Map<string, SearchProviderFactory>([
  ["tavily", createTavilyProvider],
]);

export function registerSearchProvider(
  providerId: string,
  factory: SearchProviderFactory,
): void {
  const normalizedProviderId = normalizeProviderId(providerId);
  providerFactories.set(normalizedProviderId, factory);
}

export function createSearchProvider(
  config: SearchProviderConfig,
): SearchProvider {
  const providerId = normalizeProviderId(config.providerId);
  const factory = providerFactories.get(providerId);
  if (factory === undefined) {
    throw new UnknownProviderError(providerId);
  }

  const apiKey = config.apiKey.trim();
  if (apiKey === "") {
    throw new InvalidProviderConfigError(
      `Search provider "${providerId}" requires an API key.`,
    );
  }

  return factory({
    ...config,
    apiKey,
    providerId,
  });
}

export function loadDefaultSearchProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): SearchProviderConfig {
  return {
    apiKey: env.TAVILY_API_KEY ?? "",
    baseUrl: env.TAVILY_BASE_URL,
    providerId: env.OHBABY_SEARCH_PROVIDER ?? "tavily",
  };
}

function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "") {
    throw new InvalidProviderConfigError("Search provider id must be non-empty.");
  }

  return normalized;
}
