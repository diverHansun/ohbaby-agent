import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  createSearchProvider,
  loadDefaultSearchProviderConfig,
  type FetchFormat,
  type FetchOptions,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderConfig,
  type SearchProviderFactory,
  type SearchResult,
  type SearchTimeRange,
} from "../services/search-providers/index.js";
import { ToolParameterError, getStringParam } from "./utils/params.js";
import { truncateOutput } from "./utils/output.js";

const MAX_RESULTS = 20;
const MAX_FETCH_URLS = 10;
const MAX_CHARACTERS = 20_000;
const WEB_OUTPUT_TOKEN_LIMIT = 8_000;

export interface WebToolsOptions {
  readonly createProvider?: SearchProviderFactory;
  readonly loadConfig?: () => SearchProviderConfig;
}

export function createWebTools(options: WebToolsOptions = {}): Tool[] {
  return [createWebSearchTool(options), createWebFetchTool(options)];
}

function createWebSearchTool(options: WebToolsOptions): Tool {
  return {
    annotations: { readOnlyHint: true },
    category: "network",
    description: "Search the web and return concise results with URLs.",
    execute: async (params, context): Promise<ToolExecutionResult> => {
      assertNotAborted(context);
      const query = getStringParam(params, "query");
      const searchOptions = parseSearchOptions(params);
      const provider = createProvider(options);

      const results = await provider.search(query, searchOptions);
      assertNotAborted(context);

      return renderResult({
        metadata: {
          count: results.length,
          provider: provider.id,
        },
        output: renderSearchResults(
          results,
          searchOptions.includeRawContent === true,
        ),
      });
    },
    name: "web_search",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        country: {
          description: "Optional ISO country code to bias search results.",
          type: "string",
        },
        exclude_domains: {
          items: { type: "string" },
          type: "array",
        },
        include_domains: {
          items: { type: "string" },
          type: "array",
        },
        include_raw_content: {
          type: "boolean",
        },
        max_characters: {
          maximum: MAX_CHARACTERS,
          minimum: 1,
          type: "integer",
        },
        num_results: {
          maximum: MAX_RESULTS,
          minimum: 1,
          type: "integer",
        },
        query: {
          type: "string",
        },
        time_range: {
          enum: ["day", "week", "month", "year"],
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    source: "builtin",
  };
}

function createWebFetchTool(options: WebToolsOptions): Tool {
  return {
    annotations: { readOnlyHint: true },
    category: "network",
    description: "Fetch web page content for one or more URLs.",
    execute: async (params, context): Promise<ToolExecutionResult> => {
      assertNotAborted(context);
      const urls = parseFetchUrls(params);
      const fetchOptions = parseFetchOptions(params);
      const provider = createProvider(options);

      const results = await provider.fetch(urls, fetchOptions);
      assertNotAborted(context);

      const successCount = results.filter((result) => result.success).length;
      return renderResult({
        metadata: {
          count: results.length,
          failedCount: results.length - successCount,
          provider: provider.id,
          successCount,
        },
        output: renderFetchResults(results),
      });
    },
    name: "web_fetch",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        format: {
          enum: ["markdown", "text"],
          type: "string",
        },
        include_images: {
          type: "boolean",
        },
        max_characters: {
          maximum: MAX_CHARACTERS,
          minimum: 1,
          type: "integer",
        },
        url: {
          type: "string",
        },
        urls: {
          oneOf: [
            { type: "string" },
            {
              items: { type: "string" },
              maxItems: MAX_FETCH_URLS,
              minItems: 1,
              type: "array",
            },
          ],
        },
      },
      type: "object",
    },
    source: "builtin",
  };
}

function createProvider(options: WebToolsOptions): SearchProvider {
  const loadConfig = options.loadConfig ?? loadDefaultSearchProviderConfig;
  const createProviderFromConfig = options.createProvider ?? createSearchProvider;
  return createProviderFromConfig(loadConfig());
}

function parseSearchOptions(params: Record<string, unknown>): SearchOptions {
  return compactObject({
    country: getOptionalTrimmedStringParam(params, "country"),
    excludeDomains: getOptionalStringArrayParam(params, "exclude_domains"),
    includeDomains: getOptionalStringArrayParam(params, "include_domains"),
    includeRawContent: getOptionalBooleanParam(params, "include_raw_content"),
    maxCharactersPerResult: getOptionalNumberParam(params, "max_characters", {
      integer: true,
      max: MAX_CHARACTERS,
      min: 1,
    }),
    numResults: getOptionalNumberParam(params, "num_results", {
      integer: true,
      max: MAX_RESULTS,
      min: 1,
    }),
    timeRange: getOptionalEnumParam<SearchTimeRange>(params, "time_range", [
      "day",
      "week",
      "month",
      "year",
    ]),
  });
}

function parseFetchOptions(params: Record<string, unknown>): FetchOptions {
  return compactObject({
    format: getOptionalEnumParam<FetchFormat>(params, "format", [
      "markdown",
      "text",
    ]),
    includeImages: getOptionalBooleanParam(params, "include_images"),
    maxCharactersPerUrl: getOptionalNumberParam(params, "max_characters", {
      integer: true,
      max: MAX_CHARACTERS,
      min: 1,
    }),
  });
}

function parseFetchUrls(params: Record<string, unknown>): string[] {
  const urlsValue = params.urls;
  const urlValue = params.url;
  let urls: string[];

  if (urlsValue !== undefined) {
    if (typeof urlsValue === "string") {
      urls = [urlsValue];
    } else if (Array.isArray(urlsValue)) {
      urls = urlsValue.map((value) => {
        if (typeof value !== "string") {
          throw new ToolParameterError(
            'Expected parameter "urls" to be a string or array of strings.',
          );
        }
        return value;
      });
    } else {
      throw new ToolParameterError(
        'Expected parameter "urls" to be a string or array of strings.',
      );
    }
  } else if (typeof urlValue === "string") {
    urls = [urlValue];
  } else {
    throw new ToolParameterError('Expected parameter "urls" or "url".');
  }

  if (urls.length === 0 || urls.length > MAX_FETCH_URLS) {
    throw new ToolParameterError(
      `Expected between 1 and ${String(MAX_FETCH_URLS)} URLs.`,
    );
  }

  return urls.map(normalizeHttpUrl);
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ToolParameterError("Expected URL to be non-empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolParameterError(`Expected a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolParameterError("Expected URL protocol to be http or https.");
  }

  return trimmed;
}

function getOptionalTrimmedStringParam(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be non-empty.`,
    );
  }

  return trimmed;
}

function getOptionalStringArrayParam(
  params: Record<string, unknown>,
  name: string,
): readonly string[] | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be an array of strings.`,
    );
  }

  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ToolParameterError(
        `Expected parameter "${name}" to be an array of strings.`,
      );
    }

    const trimmed = item.trim();
    if (trimmed === "") {
      throw new ToolParameterError(
        `Expected parameter "${name}" to contain non-empty strings.`,
      );
    }
    return trimmed;
  });
}

function getOptionalBooleanParam(
  params: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a boolean.`);
  }

  return value;
}

function getOptionalNumberParam(
  params: Record<string, unknown>,
  name: string,
  options: {
    readonly integer?: boolean;
    readonly min?: number;
    readonly max?: number;
  },
): number | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ToolParameterError(`Expected parameter "${name}" to be a number.`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new ToolParameterError(`Expected parameter "${name}" to be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be at least ${String(options.min)}.`,
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be at most ${String(options.max)}.`,
    );
  }

  return value;
}

function getOptionalEnumParam<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowedValues: readonly T[],
): T | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a string.`);
  }
  if (!allowedValues.includes(value as T)) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be one of: ${allowedValues.join(", ")}.`,
    );
  }

  return value as T;
}

function renderSearchResults(
  results: readonly SearchResult[],
  includeRawContent: boolean,
): string {
  if (results.length === 0) {
    return "No web search results.";
  }

  return results
    .map((result, index) => {
      const metadata = [
        result.publishedDate,
        result.score !== undefined ? `score ${result.score.toFixed(3)}` : undefined,
      ].filter((value): value is string => value !== undefined);

      return [
        `${String(index + 1)}. [${escapeMarkdownLinkText(result.title)}](${result.url})`,
        metadata.length > 0 ? metadata.join(" | ") : undefined,
        result.content.trim() === "" ? undefined : result.content,
        includeRawContent && result.rawContent?.trim()
          ? `Raw content:\n${result.rawContent}`
          : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .join("\n");
    })
    .join("\n\n");
}

function renderFetchResults(
  results: readonly {
    readonly url: string;
    readonly success: boolean;
    readonly content?: string;
    readonly error?: string;
    readonly images?: readonly string[];
  }[],
): string {
  if (results.length === 0) {
    return "No web pages fetched.";
  }

  return results
    .map((result) => {
      if (!result.success) {
        return [`## ${result.url}`, `Failed: ${result.error ?? "Unknown error"}`]
          .join("\n");
      }

      const images =
        result.images !== undefined && result.images.length > 0
          ? ["Images:", ...result.images.map((image) => `- ${image}`)]
          : [];
      return [
        `## ${result.url}`,
        result.content?.trim() === "" ? undefined : result.content,
        ...images,
      ]
        .filter((value): value is string => value !== undefined)
        .join("\n");
    })
    .join("\n\n");
}

function renderResult(input: {
  readonly output: string;
  readonly metadata: Record<string, unknown>;
}): ToolExecutionResult {
  const output = truncateOutput(input.output, WEB_OUTPUT_TOKEN_LIMIT);
  return {
    metadata: {
      ...input.metadata,
      truncated: output !== input.output,
    },
    output,
  };
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function assertNotAborted(context: ToolExecutionContext): void {
  if (context.signal.aborted) {
    throw new Error("Tool call was cancelled.");
  }
}
