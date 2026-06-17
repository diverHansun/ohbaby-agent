import { z } from "zod";

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type SearchConfigErrorCode =
  | "FILE_NOT_FOUND"
  | "INVALID_JSON"
  | "LOAD_FAILED"
  | "VALIDATION_FAILED"
  | "UNKNOWN_PROVIDER"
  | "MISSING_API_KEY"
  | "EMPTY_API_KEY";

export class SearchConfigError extends Error {
  readonly code: SearchConfigErrorCode;
  readonly context?: Record<string, unknown>;
  readonly path?: string;

  constructor(input: {
    readonly code: SearchConfigErrorCode;
    readonly message: string;
    readonly path?: string;
    readonly context?: Record<string, unknown>;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "SearchConfigError";
    this.code = input.code;
    this.path = input.path;
    this.context = input.context;
  }
}

export const SearchDefaultsConfigSchema = z
  .object({
    searchDepth: z.enum(["basic", "advanced"]).optional().default("basic"),
    maxResults: z.number().int().min(1).max(20).optional().default(5),
    topic: z.enum(["general", "news", "finance"]).optional().default("general"),
    timeout: z.number().int().min(1).max(600).optional().default(60),
  })
  .strict();

export const SearchJsonConfigSchema = z
  .object({
    provider: z.enum(["tavily"]).optional().default("tavily"),
    apiKeyEnv: z
      .string()
      .trim()
      .min(1)
      .regex(ENV_VAR_NAME_PATTERN, "must be an environment variable name")
      .optional()
      .default("TAVILY_API_KEY"),
    baseUrl: z.string().url().optional(),
    defaults: SearchDefaultsConfigSchema.optional().default({}),
  })
  .strict();

export type SearchJsonConfig = z.infer<typeof SearchJsonConfigSchema>;

export interface SearchConfig {
  readonly provider: "tavily";
  readonly apiKey: string;
  readonly apiKeyEnvName: string;
  readonly baseUrl?: string;
  readonly defaults: {
    readonly searchDepth: "basic" | "advanced";
    readonly maxResults: number;
    readonly topic: "general" | "news" | "finance";
    readonly timeout: number;
  };
}

export interface SearchConfigLoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly searchJsonPath?: string;
}
