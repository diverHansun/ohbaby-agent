import fs from "node:fs/promises";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { createGlobMatcher, scanFiles, splitTextLines } from "./utils/files.js";
import {
  getNumberParam,
  getOptionalStringParam,
  getStringParam,
} from "./utils/params.js";
import { renderList } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import {
  BinaryTextFileError,
  DEFAULT_SEARCH_LIMIT,
  FILE_PATH_SCHEMA,
  MAX_SEARCH_VISITED_FILES,
  MAX_TEXT_FILE_BYTES,
  readTextFileContent,
  TextFileTooLargeError,
} from "./utils/text-files.js";

export function createGrepTool(): Tool {
  return {
    name: "grep",
    description:
      "Search text files by regular expression inside the workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        include: { type: "string" },
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
      const include = getOptionalStringParam(params, "include") ?? "**/*";
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const regex = new RegExp(pattern, "u");
      const includeMatcher = createGlobMatcher(include);
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const matches: string[] = [];
      let skippedBinaryFiles = 0;
      let skippedLargeFiles = 0;
      const scan = await scanFiles({
        basePath: resolvedPath,
        maxVisitedFiles: MAX_SEARCH_VISITED_FILES,
        async visit(file) {
          if (!includeMatcher(file.relativePath)) {
            return true;
          }
          const stats = await fs.stat(file.absolutePath);
          if (stats.size > MAX_TEXT_FILE_BYTES) {
            skippedLargeFiles += 1;
            return true;
          }

          let content: string;
          try {
            content = (
              await readTextFileContent(file.absolutePath, file.relativePath)
            ).text;
          } catch (error) {
            if (error instanceof BinaryTextFileError) {
              skippedBinaryFiles += 1;
              return true;
            }
            if (error instanceof TextFileTooLargeError) {
              skippedLargeFiles += 1;
              return true;
            }
            throw error;
          }

          const lines = splitTextLines(content);
          for (const [index, line] of lines.entries()) {
            if (regex.test(line)) {
              matches.push(
                `${file.relativePath}:${String(index + 1)}: ${line}`,
              );
              if (matches.length >= limit) {
                return false;
              }
            }
          }

          return true;
        },
      });

      return {
        output: renderList(matches, "No matches found."),
        metadata: {
          count: matches.length,
          skippedBinaryFiles,
          skippedLargeFiles,
          truncated: scan.truncated || matches.length >= limit,
          visitedFileCount: scan.visitedFileCount,
        },
      };
    },
  };
}
