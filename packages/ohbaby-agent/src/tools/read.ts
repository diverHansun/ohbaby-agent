import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { formatWithLineNumbers } from "../utils/index.js";
import { splitTextLines } from "./utils/files.js";
import { getNumberParam, getStringParam } from "./utils/params.js";
import { truncateOutput } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import {
  DEFAULT_READ_LIMIT,
  FILE_PATH_SCHEMA,
  MAX_READ_LIMIT,
  readTextFileContent,
} from "./utils/text-files.js";

export function createReadTool(): Tool {
  return {
    name: "read",
    description: "Read a text file from the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        file_path: FILE_PATH_SCHEMA,
        limit: { minimum: 1, type: "integer" },
        offset: { minimum: 1, type: "integer" },
      },
      required: ["file_path"],
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const offset = getNumberParam(params, "offset", {
        defaultValue: 1,
        integer: true,
        min: 1,
      });
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_READ_LIMIT,
        integer: true,
        max: MAX_READ_LIMIT,
        min: 1,
      });
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const file = await readTextFileContent(resolvedPath, inputPath);
      const lines = splitTextLines(file.text);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const hasMore = offset - 1 + selected.length < lines.length;
      const output = formatWithLineNumbers(selected, { startLine: offset });

      return {
        output: truncateOutput(output),
        metadata: {
          encoding: file.encoding,
          hasMore,
          lineCount: lines.length,
          lineEnding: file.lineEnding,
          mtimeMs: file.mtimeMs,
          nextOffset: hasMore ? offset + selected.length : undefined,
          path: resolvedPath,
          shownLineCount: selected.length,
          sizeBytes: file.sizeBytes,
        },
      };
    },
  };
}
