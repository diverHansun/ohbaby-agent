import { withFileAccess } from "./utils/file-access.js";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getBooleanParam,
  getNumberParam,
  optionalEnum,
  ToolParameterError,
  getOptionalStringParam,
  getStringParam,
} from "./utils/params.js";
import { resolvePathForExisting } from "./utils/context.js";
import { DEFAULT_SEARCH_LIMIT, FILE_PATH_SCHEMA } from "./utils/text-files.js";
import {
  resolveBundledRipgrepPath,
  searchWithRipgrep,
  type RipgrepMatch,
  type SearchStopReason,
} from "./utils/ripgrep-search.js";

const OUTPUT_BYTES = 50 * 1024;
const NOTICE_RESERVE_BYTES = 1024;
const PREVIEW_BYTES = 2000;
const PREVIEW_OMITTED = " [preview omitted; use read for full content]";

function preview(match: RipgrepMatch): { text: string; limited: boolean } {
  if (match.text === undefined)
    return {
      text: "Preview unavailable: matched line is not valid UTF-8.",
      limited: true,
    };
  const bytes = Buffer.from(match.text.replace(/\r?\n$/u, ""));
  if (bytes.length <= PREVIEW_BYTES)
    return { text: bytes.toString("utf8"), limited: false };
  const budget = PREVIEW_BYTES - Buffer.byteLength(PREVIEW_OMITTED) - 3;
  let start = Math.min(
    Math.max(0, match.matchStart - 200),
    Math.max(0, bytes.length - budget),
  );
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.length, start + budget);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: `${start ? "..." : ""}${bytes.subarray(start, end).toString("utf8")}${PREVIEW_OMITTED}`,
    limited: true,
  };
}

const STOP_NOTICE: Record<SearchStopReason, string> = {
  "match-limit":
    "The matching-line limit was reached; completeness and additional matches are not confirmed.",
  "output-limit":
    "The 50 KiB output budget was reached; completeness and additional matches are not confirmed.",
  "record-limit": "A raw ripgrep record exceeded the 4 MiB receive limit.",
  "stdout-limit": "Raw ripgrep output exceeded the 16 MiB receive budget.",
};

export function createGrepTool(): Tool {
  return withFileAccess(
    {
      name: "grep",
      description:
        "Search file contents with a regular expression. Use this instead of shell grep or rg. Uses ripgrep's default regex syntax (no look-around or backreferences). Defaults to output_mode=content (paths, line numbers, limited previews, and optional before/after context up to 20 lines; matches use path:line:, context uses path-line-, separated by --); also supports output_mode=files (paths only), output_mode=count (matching lines per file), and ignore_case. Use read for full lines or wider context. Directory searches honor project .gitignore/.ignore/.rgignore (parent/global ignores disabled), include hidden files, and exclude .git traversal. Explicit include follows ripgrep glob precedence and can override ignore rules (except .git during traversal), but does not filter a single-file path. Binary files and non-UTF-8 encodings are not guaranteed (non-UTF-8 previews may be unavailable; matched paths must be valid UTF-8); use bash for raw bytes or other encodings.",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          before: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description:
              "Context lines to include before each match, like grep -B (0-20, default: 0; content mode only). For more than 20 lines, get the line number with grep and read the file with read using offset.",
          },
          after: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description:
              "Context lines to include after each match, like grep -A (0-20, default: 0; content mode only). For more than 20 lines, get the line number with grep and read the file with read using offset.",
          },
          ignore_case: {
            type: "boolean",
            description:
              "Case-insensitive pattern matching, like grep -i (default: false).",
          },
          output_mode: {
            type: "string",
            enum: ["content", "files", "count"],
            description:
              "Output format (default: content). content returns matching lines with previews and optional before/after context; files returns matching file paths only; count returns matching line counts per file. before and after are only allowed with content.",
          },

          include: {
            description:
              'Ripgrep glob to filter searched files (e.g. "*.ts" by name or "src/**/*.ts" by path). Can override .gitignore; ignored when path is a single file.',
            type: "string",
          },
          limit: {
            minimum: 1,
            type: "integer",
            description:
              "Maximum matching lines in content mode (context lines are not counted), or maximum matching files in files/count modes (default: 100). Output is still capped at 50 KiB.",
          },
          path: {
            ...FILE_PATH_SCHEMA,
            description:
              "File or directory to search. Defaults to the workspace root. Accepts absolute, ~/, or workspace-relative paths; external directories ask for approval on first access.",
          },
          pattern: {
            description:
              "Ripgrep default regular expression (no look-around or backreferences).",
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
        const pattern = getStringParam(params, "pattern");
        const include = getOptionalStringParam(params, "include");
        const inputPath = getOptionalStringParam(params, "path") ?? ".";
        const limit = getNumberParam(params, "limit", {
          defaultValue: DEFAULT_SEARCH_LIMIT,
          integer: true,
          min: 1,
        });
        const mode = optionalEnum(
          params,
          "output_mode",
          ["content", "files", "count"],
          {
            defaultValue: "content",
            invalidMessage: () =>
              "Expected output_mode to be content, files, or count.",
          },
        );
        if (
          mode !== "content" &&
          (params.before !== undefined || params.after !== undefined)
        )
          throw new ToolParameterError(
            "before and after can only be used when output_mode is content.",
          );
        const contextRange = {
          defaultValue: 0,
          integer: true,
          min: 0,
          max: 20,
        };
        const before = getNumberParam(params, "before", contextRange);
        const after = getNumberParam(params, "after", contextRange);
        const ignoreCase = getBooleanParam(params, "ignore_case", false);
        if (context.signal.aborted)
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error("Search cancelled.");
        const resolvedPath = await resolvePathForExisting(context, inputPath);
        const stats = await fs.stat(resolvedPath);
        if (!stats.isDirectory() && !stats.isFile())
          throw new Error(
            "Search failed: path must be a regular file or directory.",
          );
        const matches: string[] = [];
        let outputBytes = 0;
        let matchCount = 0;
        let count = 0;
        const display = { limited: false };
        let previous: RipgrepMatch | undefined;
        let remainingAfter = 0;
        function append(line: string): boolean {
          const cost = Buffer.byteLength(line) + 1;
          if (outputBytes + cost > OUTPUT_BYTES - NOTICE_RESERVE_BYTES)
            return false;
          matches.push(line);
          outputBytes += cost;
          return true;
        }
        const result = await searchWithRipgrep({
          executablePath: resolveBundledRipgrepPath(),
          cwd: stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath),
          target: resolvedPath,
          pattern,
          include,
          signal: context.signal,
          before,
          after,
          ignoreCase,
          firstMatchPerFile: mode === "files",
          onFileEnd:
            mode === "content"
              ? undefined
              : (file, lines, occurrences): SearchStopReason | undefined => {
                  if (
                    !append(
                      mode === "files" ? file : file + ": " + String(lines),
                    )
                  )
                    return "output-limit";
                  count += 1;
                  matchCount += occurrences;
                  return count >= limit ? "match-limit" : undefined;
                },
          onMatch(match) {
            if (mode !== "content") return;
            const isMatch = match.matchCount > 0;
            const adjacent =
              previous?.path === match.path && previous.line + 1 === match.line;
            if (count >= limit && (isMatch || !adjacent || remainingAfter <= 0))
              return "match-limit";
            const rendered = preview(match);
            const separator = isMatch ? ":" : "-";
            const line =
              match.path +
              separator +
              String(match.line) +
              separator +
              " " +
              rendered.text;
            if (
              !append(
                (previous && (before || after) && !adjacent ? "--\n" : "") +
                  line,
              )
            )
              return "output-limit";
            previous = match;
            display.limited ||= rendered.limited;
            if (isMatch) {
              count += 1;
              matchCount += match.matchCount;
              remainingAfter = after;
            } else {
              remainingAfter -= 1;
            }
            return count >= limit && remainingAfter <= 0
              ? "match-limit"
              : undefined;
          },
        });
        const scanComplete = !result.stopReason && result.binaryFileCount === 0;
        const notices: string[] = [];
        if (result.stopReason)
          notices.push(
            `Search incomplete: ${result.stopReason === "match-limit" && mode !== "content" ? "The matching-file limit was reached; completeness and additional matching files are not confirmed." : STOP_NOTICE[result.stopReason]} Narrow path/include/pattern, or use output_mode=files to list paths only.`,
          );
        if (result.binaryFileCount)
          notices.push(
            `Search incomplete: binary detection stopped or suppressed content in ${String(result.binaryFileCount)} file(s). Binary contents are outside the text-search guarantee.`,
          );
        if (display.limited)
          notices.push(
            "Result display limited: some previews are omitted or unavailable. Use read at the returned path and line for details (read supports UTF-8).",
          );
        const output = [
          matches.length
            ? matches.join("\n")
            : scanComplete
              ? "No matches found in the declared text-search scope (binary contents are not guaranteed)."
              : "No matching locations were returned from the scanned portion.",
          ...notices,
        ].join("\n\n");
        return {
          output,
          metadata: {
            count,
            matchCount,
            scanComplete,
            displayLimited: display.limited || Boolean(result.stopReason),
            truncated: !scanComplete || display.limited,
            stopReason: result.stopReason,
            binaryFileCount: result.binaryFileCount,
            processExited: result.processExited,
          },
        };
      },
    },
    "search",
  );
}
