import { withFileAccess } from "./utils/file-access.js";
import fs from "node:fs/promises";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getNumberParam,
  getOptionalStringParam,
  getStringArrayParam,
} from "./utils/params.js";
import { persistDisplayedOutput, renderList } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import { DEFAULT_SEARCH_LIMIT, FILE_PATH_SCHEMA } from "./utils/text-files.js";

export function createListTool(): Tool {
  return withFileAccess(
    {
      name: "list",
      description:
        "List immediate entries (files and subdirectories) of one directory. Use this instead of ls; use glob for recursive search. Includes hidden entries, always skips .git, node_modules, and dist, and returns sorted names (directories end with /).",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          ignore: {
            description:
              "Exact immediate entry names to omit (not globs). .git, node_modules, and dist are always omitted.",
            items: { type: "string" },
            type: "array",
          },
          limit: {
            description: "Maximum entries to return (default: 100).",
            minimum: 1,
            type: "integer",
          },
          path: {
            ...FILE_PATH_SCHEMA,
            description:
              "Directory to list. Defaults to the workspace root. Accepts absolute, ~/, or workspace-relative paths; external directories ask for approval on first access.",
          },
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
          .filter(
            (entry) => ![".git", "node_modules", "dist"].includes(entry.name),
          )
          .sort((first, second) => first.name.localeCompare(second.name));
        const lines = visible.slice(0, limit).map((entry) => {
          return entry.isDirectory() ? `${entry.name}/` : entry.name;
        });
        const truncated = visible.length > limit;
        if (truncated) {
          lines.push(`... (${String(visible.length - limit)} more entries)`);
        }

        const acquired = lines.length
          ? lines.join("\n")
          : "Directory is empty.";
        const displayed = renderList(lines, "Directory is empty.");
        const displayLimited = displayed !== acquired;
        return persistDisplayedOutput({
          context,
          acquired,
          displayed,
          displayLimited,
          metadata: {
            count: Math.min(visible.length, limit),
            truncated,
            displayLimited,
          },
        });
      },
    },
    "tree",
  );
}
