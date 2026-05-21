import type { Tool, ToolExecutionResult } from "../core/tool-scheduler/index.js";
import { createGlobMatcher, scanFiles } from "./utils/files.js";
import { getNumberParam, getOptionalStringParam, getStringParam } from "./utils/params.js";
import { renderList } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import {
  DEFAULT_SEARCH_LIMIT,
  FILE_PATH_SCHEMA,
  MAX_SEARCH_VISITED_FILES,
} from "./utils/text-files.js";

export function createGlobTool(): Tool {
  return {
    name: "glob",
    description: "Find files by glob pattern inside the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        limit: { minimum: 1, type: "integer" },
        path: FILE_PATH_SCHEMA,
        pattern: { type: "string" },
      },
      required: ["pattern"],
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const pattern = getStringParam(params, "pattern");
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const matcher = createGlobMatcher(pattern);
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const matches: string[] = [];
      const scan = await scanFiles({
        basePath: resolvedPath,
        maxVisitedFiles: MAX_SEARCH_VISITED_FILES,
        visit(file) {
          if (matcher(file.relativePath)) {
            matches.push(file.relativePath);
          }

          return matches.length < limit;
        },
      });
      const truncated = scan.truncated || matches.length >= limit;

      return {
        output: renderList(matches, "No files matched."),
        metadata: {
          count: matches.length,
          truncated,
          visitedFileCount: scan.visitedFileCount,
        },
      };
    },
  };
}
