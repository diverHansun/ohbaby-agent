import fs from "node:fs/promises";
import type { Tool, ToolExecutionResult } from "../core/tool-scheduler/index.js";
import { getNumberParam, getOptionalStringParam, getStringArrayParam } from "./utils/params.js";
import { renderList } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import { DEFAULT_SEARCH_LIMIT, FILE_PATH_SCHEMA } from "./utils/text-files.js";

export function createListTool(): Tool {
  return {
    name: "list",
    description: "List immediate files and directories in the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        ignore: { items: { type: "string" }, type: "array" },
        limit: { minimum: 1, type: "integer" },
        path: FILE_PATH_SCHEMA,
      },
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getOptionalStringParam(params, "path") ?? ".";
      const ignore = new Set(getStringArrayParam(params, "ignore"));
      const limit = getNumberParam(params, "limit", {
        defaultValue: DEFAULT_SEARCH_LIMIT,
        integer: true,
        min: 1,
      });
      const resolvedPath = await resolvePathForExisting(context, inputPath);
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const visible = entries
        .filter((entry) => !ignore.has(entry.name))
        .filter((entry) => ![".git", "node_modules", "dist"].includes(entry.name))
        .sort((first, second) => first.name.localeCompare(second.name));
      const lines = visible.slice(0, limit).map((entry) => {
        return entry.isDirectory() ? `${entry.name}/` : entry.name;
      });
      const truncated = visible.length > limit;
      if (truncated) {
        lines.push(`... (${String(visible.length - limit)} more entries)`);
      }

      return {
        output: renderList(lines, "Directory is empty."),
        metadata: { count: Math.min(visible.length, limit), truncated },
      };
    },
  };
}
