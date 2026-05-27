import { z } from "zod";
import {
  SearchConfigError,
  SearchJsonConfigSchema,
  type SearchJsonConfig,
} from "./types.js";

function formatZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const issuePath = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

export function validateSearchJson(
  input: unknown,
  sourcePath?: string,
): SearchJsonConfig {
  const result = SearchJsonConfigSchema.safeParse(input);
  if (!result.success) {
    throw new SearchConfigError({
      code: "VALIDATION_FAILED",
      message: `Invalid search configuration${
        sourcePath ? ` at ${sourcePath}` : ""
      }: ${formatZodIssues(result.error.issues)}`,
      path: sourcePath,
      context: { issues: result.error.issues },
    });
  }
  return result.data;
}

export function validateApiKey(
  env: NodeJS.ProcessEnv,
  apiKeyEnvName: string,
): string {
  const value = env[apiKeyEnvName];
  if (value === undefined) {
    throw new SearchConfigError({
      code: "MISSING_API_KEY",
      message: `Missing search API key environment variable: ${apiKeyEnvName}`,
      context: { apiKeyEnvName },
    });
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    throw new SearchConfigError({
      code: "EMPTY_API_KEY",
      message: `Search API key environment variable is empty: ${apiKeyEnvName}`,
      context: { apiKeyEnvName },
    });
  }

  return trimmed;
}
