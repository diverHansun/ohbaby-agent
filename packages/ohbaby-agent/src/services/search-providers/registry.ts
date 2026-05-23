import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
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

const ENV_FILE_NAME = ".env";

export interface LoadDefaultSearchProviderConfigOptions {
  readonly projectDirectory?: string;
}

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
  options: LoadDefaultSearchProviderConfigOptions = {},
): SearchProviderConfig {
  const projectEnv = loadProjectSearchEnv(options.projectDirectory);
  return {
    apiKey: env.TAVILY_API_KEY ?? projectEnv.TAVILY_API_KEY ?? "",
    baseUrl: env.TAVILY_BASE_URL ?? projectEnv.TAVILY_BASE_URL,
    providerId:
      env.OHBABY_SEARCH_PROVIDER ??
      projectEnv.OHBABY_SEARCH_PROVIDER ??
      "tavily",
  };
}

function loadProjectSearchEnv(
  projectDirectory = process.cwd(),
): Readonly<Partial<Record<string, string>>> {
  const envPath = join(projectDirectory, ENV_FILE_NAME);
  try {
    return parseDotenv(readFileSync(envPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new InvalidProviderConfigError(
      `Failed to read project .env file: ${(error as Error).message}`,
    );
  }
}

function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "") {
    throw new InvalidProviderConfigError(
      "Search provider id must be non-empty.",
    );
  }

  return normalized;
}
