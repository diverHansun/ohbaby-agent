export type SearchTimeRange = "day" | "week" | "month" | "year";

export type FetchFormat = "markdown" | "text" | "html";

export interface SearchOptions {
  readonly numResults?: number;
  readonly includeDomains?: readonly string[];
  readonly excludeDomains?: readonly string[];
  readonly timeRange?: SearchTimeRange;
  readonly country?: string;
  readonly includeRawContent?: boolean;
  readonly maxCharactersPerResult?: number;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly rawContent?: string;
  readonly score?: number;
  readonly publishedDate?: string;
}

export interface FetchOptions {
  readonly format?: FetchFormat;
  readonly includeImages?: boolean;
  readonly maxCharactersPerUrl?: number;
}

export interface FetchResult {
  readonly url: string;
  readonly success: boolean;
  readonly content?: string;
  readonly error?: string;
  readonly images?: readonly string[];
}

export interface SearchProvider {
  readonly id: string;
  readonly search: (
    query: string,
    options?: SearchOptions,
  ) => Promise<SearchResult[]>;
  readonly fetch: (
    urls: readonly string[],
    options?: FetchOptions,
  ) => Promise<FetchResult[]>;
}

export interface SearchProviderConfig {
  readonly providerId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaults?: unknown;
}

export type SearchProviderFactory = (
  config: SearchProviderConfig,
) => SearchProvider;

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown search provider: ${providerId}`);
    this.name = "UnknownProviderError";
  }
}

export class InvalidProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderConfigError";
  }
}
