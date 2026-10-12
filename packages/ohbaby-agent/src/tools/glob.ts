import fs from "node:fs/promises";
import { withFileAccess } from "./utils/file-access.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getNumberParam,
  getOptionalStringParam,
  getStringParam,
  ToolParameterError,
} from "./utils/params.js";
import { DEFAULT_OUTPUT_TOKEN_LIMIT } from "./utils/output.js";
import { truncateIfTooLong } from "../utils/truncate.js";
import { resolvePathForExisting } from "./utils/context.js";
import { DEFAULT_SEARCH_LIMIT, FILE_PATH_SCHEMA } from "./utils/text-files.js";
import { resolveBundledRipgrepPath } from "./utils/ripgrep-search.js";
import {
  listFilesWithRipgrep,
  normalizeGlobPattern,
} from "./utils/ripgrep-files.js";

export function createGlobTool(): Tool {
  return withFileAccess(
    {
      name: "glob",
      description:
        "Find ordinary files with ripgrep globs relative to the search root. Supports *, ?, **, {a,b}, and [ab]; *.ts matches only the root, **/*.ts matches recursively. For a literal [id] directory use app/[[]id]/*.tsx. Includes hidden files and ignores ignore files; .git, dist, node_modules, out, target remain excluded. Does not follow internal symlinks. Returns sorted paths and explicit scan completeness; narrow the pattern or root when results are incomplete.",
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
        const pattern = normalizeGlobPattern(getStringParam(params, "pattern"));
        const inputPath = getOptionalStringParam(params, "path") ?? ".";
        const limit = getNumberParam(params, "limit", {
          defaultValue: DEFAULT_SEARCH_LIMIT,
          integer: true,
          min: 1,
        });
        const resolvedPath = await resolvePathForExisting(context, inputPath);
        if (!(await fs.stat(resolvedPath)).isDirectory())
          throw new ToolParameterError("Glob search root must be a directory.");
        const matches: string[] = [];
        const scan = await listFilesWithRipgrep({
          executablePath: resolveBundledRipgrepPath(),
          cwd: resolvedPath,
          pattern,
          signal: context.signal,
          reportCleanup: (state) => {
            if (state === "unconfirmed")
              context.resourceLease?.markUnconfirmed();
            context.reportCleanup?.(state);
          },
          reportCleanupError: context.reportCleanupError,
          onPath(relativePath) {
            if (matches.length >= limit) return "match-limit";
            matches.push(
              Array.from(relativePath).some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127,
              )
                ? JSON.stringify(relativePath)
                : relativePath,
            );
            return undefined;
          },
        });
        const scanComplete = !scan.stopReason;
        const rendered = matches.length
          ? truncateIfTooLong(matches, DEFAULT_OUTPUT_TOKEN_LIMIT).join("\n")
          : scanComplete
            ? "No files matched."
            : "No file paths were returned from the scanned portion.";
        const displayLimited =
          matches.length > 0 && rendered !== matches.join("\n");
        const notice = scan.stopReason
          ? `\n\nGlob incomplete (${scan.stopReason}). Narrow the pattern or search root.`
          : "";
        return {
          output: rendered + notice,
          metadata: {
            count: matches.length,
            truncated: !scanComplete,
            scanComplete,
            displayLimited,
            stopReason: scan.stopReason,
          },
        };
      },
    },
    "tree",
    { cleanupOwner: "tool" },
  );
}
