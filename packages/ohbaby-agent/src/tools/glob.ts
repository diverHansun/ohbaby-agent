import fs from "node:fs/promises";
import { withFileAccess } from "./utils/file-access.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getBooleanParam,
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
        "Find ordinary files by relative ripgrep glob (use instead of find/ls -R). Supports *, ?, **, {a,b}, [ab] (*.ts: root only; **/*.ts: recursive; literal [id]: app/[[]id]/*.tsx). Includes hidden files. Applies .gitignore/.ignore/.rgignore only in path and below (no ancestor or global ignores). Broad globs (**, **/*, prefix/**, prefix/**/*) honor ignores; other specific globs follow ripgrep precedence and can override matching file or directory ignores. Use include_ignored=true or pass an ignored directory as path to search ignored paths; .git, dist, node_modules, out, and target are always excluded even with include_ignored=true. No internal symlinks; UTF-8 paths only; sorted with scan completeness (narrow when incomplete).",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          include_ignored: {
            type: "boolean",
            description:
              "Include project-ignored files and directories (default: false).",
          },
          limit: {
            description: "Maximum paths (default: 100).",
            minimum: 1,
            type: "integer",
          },
          path: {
            ...FILE_PATH_SCHEMA,
            description:
              "Search directory (default: workspace root; absolute, ~/, or relative; external asks approval).",
          },
          pattern: {
            description: "Relative ripgrep glob (no leading / or ..).",
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
          includeIgnored: getBooleanParam(params, "include_ignored", false),
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
            ? "No files matched. Project ignore files (.gitignore/.ignore/.rgignore) are applied by default; retry with include_ignored=true or pass an ignored directory directly as path if needed."
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
