import { tavily } from "@tavily/core";
import type {
  TavilyClient,
  TavilyExtractOptions,
  TavilyProxyOptions,
  TavilySearchOptions,
} from "@tavily/core";

import {
  InvalidProviderConfigError,
  type FetchOptions,
  type FetchResult,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderConfig,
  type SearchResult,
} from "./types.js";

interface TavilySearchDefaults {
  readonly includeRawContent?: false | "markdown" | "text";
  readonly maxResults?: number;
  readonly searchDepth?: "basic" | "advanced";
  readonly timeout?: number;
  readonly topic?: "general" | "news" | "finance";
}

interface TavilyExtractDefaults {
  readonly extractDepth?: "basic" | "advanced";
  readonly timeout?: number;
  readonly format?: "markdown" | "text";
  readonly includeImages?: boolean;
}

interface TavilyDefaults {
  readonly proxy?: TavilyProxyOptions;
  readonly search?: TavilySearchDefaults;
  readonly extract?: TavilyExtractDefaults;
}

export function createTavilyProvider(
  config: SearchProviderConfig,
  clientOverride?: TavilyClient,
): SearchProvider {
  const apiKey = config.apiKey.trim();
  if (apiKey === "") {
    throw new InvalidProviderConfigError("Tavily search provider requires an API key.");
  }

  const defaults = normalizeDefaults(config.defaults);
  const client =
    clientOverride ??
    tavily(
      compactObject({
        apiBaseURL: config.baseUrl,
        apiKey,
        proxies: defaults.proxy,
      }),
    );

  return {
    id: "tavily",
    fetch: async (urls, options): Promise<FetchResult[]> => {
      const normalizedUrls = normalizeUrls(urls);
      const extractOptions = buildExtractOptions(defaults.extract, options);
      try {
        const response = await client.extract(
          [...normalizedUrls],
          extractOptions,
        );
        return normalizeFetchResults(normalizedUrls, response, options);
      } catch (error) {
        throw mapTavilyError(error);
      }
    },
    search: async (query, options): Promise<SearchResult[]> => {
      const normalizedQuery = normalizeQuery(query);
      const searchOptions = buildSearchOptions(defaults.search, options);
      try {
        const response = await client.search(normalizedQuery, searchOptions);
        return response.results
          .map((result) => normalizeSearchResult(result, options))
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      } catch (error) {
        throw mapTavilyError(error);
      }
    },
  };
}

function normalizeDefaults(defaults: unknown): TavilyDefaults {
  if (typeof defaults !== "object" || defaults === null) {
    return {};
  }

  return defaults;
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (normalized === "") {
    throw new InvalidProviderConfigError("Tavily search query must be non-empty.");
  }

  return normalized;
}

function normalizeUrls(urls: readonly string[]): readonly string[] {
  if (urls.length === 0) {
    throw new InvalidProviderConfigError("Tavily fetch urls must be non-empty.");
  }

  return urls.map((url) => {
    const normalized = url.trim();
    if (normalized === "") {
      throw new InvalidProviderConfigError(
        "Tavily fetch urls must contain non-empty strings.",
      );
    }
    return normalized;
  });
}

function buildSearchOptions(
  defaults: TavilySearchDefaults | undefined,
  options: SearchOptions | undefined,
): TavilySearchOptions {
  const maxResults = options?.numResults ?? defaults?.maxResults ?? 5;
  assertIntegerInRange("numResults", maxResults, 1, 20);

  return compactObject({
    country: options?.country,
    excludeDomains: toMutableArray(options?.excludeDomains),
    includeDomains: toMutableArray(options?.includeDomains),
    includeRawContent:
      options?.includeRawContent === true
        ? (defaults?.includeRawContent ?? "markdown")
        : false,
    maxResults,
    searchDepth: defaults?.searchDepth ?? "basic",
    timeRange: options?.timeRange,
    timeout: defaults?.timeout,
    topic: defaults?.topic ?? "general",
  });
}

function buildExtractOptions(
  defaults: TavilyExtractDefaults | undefined,
  options: FetchOptions | undefined,
): TavilyExtractOptions {
  if (options?.format === "html") {
    throw new InvalidProviderConfigError(
      "Tavily provider does not support html fetch format.",
    );
  }

  return compactObject({
    extractDepth: defaults?.extractDepth ?? "basic",
    format: options?.format ?? defaults?.format ?? "markdown",
    includeImages: options?.includeImages ?? defaults?.includeImages,
    timeout: defaults?.timeout,
  });
}

function toMutableArray(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...values];
}

function assertIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidProviderConfigError(
      `Expected ${name} to be an integer between ${String(min)} and ${String(max)}.`,
    );
  }
}

function normalizeSearchResult(
  result: {
    readonly title: string;
    readonly url: string;
    readonly content: string;
    readonly rawContent?: string;
    readonly score?: number;
    readonly publishedDate?: string;
  },
  options: SearchOptions | undefined,
): SearchResult {
  return {
    content: truncateCharacters(
      result.content,
      options?.maxCharactersPerResult,
    ),
    ...(result.publishedDate?.trim()
      ? { publishedDate: result.publishedDate }
      : {}),
    ...(result.rawContent !== undefined
      ? {
          rawContent: truncateCharacters(
            result.rawContent,
            options?.maxCharactersPerResult,
          ),
        }
      : {}),
    ...(result.score !== undefined ? { score: result.score } : {}),
    title: result.title,
    url: result.url,
  };
}

function normalizeFetchResults(
  urls: readonly string[],
  response: {
    readonly results: readonly {
      readonly url: string;
      readonly rawContent: string;
      readonly images?: readonly string[];
    }[];
    readonly failedResults: readonly {
      readonly url: string;
      readonly error: string;
    }[];
  },
  options: FetchOptions | undefined,
): FetchResult[] {
  const successes = new Map(response.results.map((result) => [result.url, result]));
  const failures = new Map(
    response.failedResults.map((result) => [result.url, result]),
  );

  return urls.map((url) => {
    const success = successes.get(url);
    if (success !== undefined) {
      return {
        content: truncateCharacters(
          success.rawContent,
          options?.maxCharactersPerUrl,
        ),
        ...(success.images !== undefined ? { images: success.images } : {}),
        success: true,
        url,
      };
    }

    const failure = failures.get(url);
    return {
      error: failure?.error ?? "No extract result returned.",
      success: false,
      url,
    };
  });
}

function truncateCharacters(value: string, maxCharacters: number | undefined): string {
  if (maxCharacters === undefined || value.length <= maxCharacters) {
    return value;
  }

  return value.slice(0, maxCharacters);
}

function mapTavilyError(error: unknown): Error {
  const status = getStatusCode(error);
  if (status === 401 || status === 403) {
    return new Error("Tavily authentication failed. Check TAVILY_API_KEY.");
  }
  if (status === 429) {
    return new Error("Tavily rate limit exceeded. Try again later.");
  }
  if (status !== undefined && status >= 500) {
    return new Error("Tavily service error. Try again later.");
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Tavily request failed: ${message}`);
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly response?: { readonly status?: unknown };
  };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }
  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }

  return undefined;
}
