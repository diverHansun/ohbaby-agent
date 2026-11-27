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
import {
  DEFAULT_OUTPUT_TOKEN_LIMIT,
  persistDisplayedOutput,
} from "./utils/output.js";
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
        "Find files by name or path pattern (for example src/**/*.ts). Use this instead of find or ls -R. Matches ordinary files with ripgrep globs relative to path (*, ?, **, {a,b}, [ab]; *.ts matches only the root, **/*.ts matches recursively; escape literal [id] as app/[[]id]/*.tsx). Includes hidden files and does not apply .gitignore, but always skips .git, dist, node_modules, out, and target. Does not follow internal symlinks. Returns sorted paths and scan completeness; narrow pattern or path when incomplete.",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          limit: {
            description: "Maximum file paths to return (default: 100).",
            minimum: 1,
            type: "integer",
          },
          path: {
            ...FILE_PATH_SCHEMA,
            description:
              "Directory to search. Defaults to the workspace root. Accepts absolute, ~/, or workspace-relative paths; external directories ask for approval on first access.",
          },
          pattern: {
            description:
              "Relative ripgrep glob (no leading / or ..). Use **/*.ts for recursive matches; *.ts matches only the search root.",
            type: "string",
          },
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
        return persistDisplayedOutput({
          context,
          acquired: matches.join("\n") + notice,
          displayed: rendered + notice,
          displayLimited,
          metadata: {
            count: matches.length,
            truncated: !scanComplete,
            scanComplete,
            displayLimited,
            stopReason: scan.stopReason,
          },
        });
      },
    },
    "tree",
    { cleanupOwner: "tool" },
  );
}
