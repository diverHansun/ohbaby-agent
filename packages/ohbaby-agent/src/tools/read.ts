import { withFileAccess } from "./utils/file-access.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getNumberParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";
import { readFilePage } from "./utils/read-file-page.js";
import { resolvePathForExisting } from "./utils/context.js";
import {
  DEFAULT_READ_LIMIT,
  FILE_PATH_SCHEMA,
  MAX_READ_LIMIT,
} from "./utils/text-files.js";

export function createReadTool(): Tool {
  return withFileAccess(
    {
      name: "read",
      description:
        "Read UTF-8 file content with original line numbers. Each call returns up to limit source lines and 50 KiB of total output, whichever is reached first. A continued partial line counts as one line for that call. Use the returned cursor to resume without skipping content. Offset scans are limited to 64 MiB; files changed between pages must be read again.",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          file_path: FILE_PATH_SCHEMA,
          limit: {
            minimum: 1,
            maximum: MAX_READ_LIMIT,
            type: "integer",
            description:
              "Maximum source lines represented in this call (default: 2000). A continued partial line counts as one line. The output byte limit may stop the response earlier.",
          },
          cursor: {
            type: "string",
            description:
              "Opaque continuation cursor returned by Read. Pass it unchanged to resume. Cannot be combined with offset. Each call has its own line limit, including the continued partial line.",
          },
          offset: { minimum: 1, type: "integer" },
        },
        required: ["file_path"],
        type: "object",
      },
      source: "builtin",
      category: "readonly",
      annotations: { readOnlyHint: true },
      async execute(params, context): Promise<ToolExecutionResult> {
        if (params.cursor !== undefined && params.offset !== undefined)
          throw new ToolParameterError(
            "cursor cannot be combined with offset.",
          );
        const cursor =
          params.cursor === undefined
            ? undefined
            : getStringParam(params, "cursor");
        const inputPath = getStringParam(params, "file_path");
        const offset = getNumberParam(params, "offset", {
          defaultValue: 1,
          integer: true,
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
        });
        const limit = getNumberParam(params, "limit", {
          defaultValue: DEFAULT_READ_LIMIT,
          integer: true,
          max: MAX_READ_LIMIT,
          min: 1,
        });
        const resolvedPath = await resolvePathForExisting(context, inputPath);
        return readFilePage({
          filePath: resolvedPath,
          offset,
          limit,
          cursor,
          signal: context.signal,
        });
      },
    },
    "read",
  );
}
