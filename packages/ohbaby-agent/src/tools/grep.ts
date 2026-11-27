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

const STOP_NOTICE: Record<SearchStopReason | "file-limit", string> = {
  "file-limit":
    "The matching-file limit was reached; completeness and additional matching files are not confirmed.",
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
        "Search file contents with ripgrep default regex (no look-around or backreferences); use instead of shell grep/rg. Default output_mode=content returns path:line: previews (context uses path-line-, separated by --); use read for full lines or >20 context lines. Directory searches include hidden files and skip .git traversal. Applies .gitignore/.ignore/.rgignore only in path and below (no ancestor or global ignores). Explicit include uses ripgrep glob precedence (can override ignores except .git; does not filter a single file). Binary and non-UTF-8 files are not guaranteed (previews may be unavailable; matched paths must be valid UTF-8); use bash for raw bytes or other encodings.",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          before: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description:
              "Context lines before each match (0-20, default: 0; content mode only).",
          },
          after: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description:
              "Context lines after each match (0-20, default: 0; content mode only).",
          },
          ignore_case: {
            type: "boolean",
            description: "Case-insensitive matching (default: false).",
          },
          output_mode: {
            type: "string",
            enum: ["content", "files", "count"],
            description:
              "content (default: lines/previews), files (paths only), or count (matching lines per file).",
          },
          include: {
            description:
              'Ripgrep file filter glob (e.g. "*.ts" or "src/**/*.ts").',
            type: "string",
          },
          limit: {
            minimum: 1,
            type: "integer",
            description:
              "Max matching lines in content mode (excluding context) or files in files/count (default: 100; 50 KiB cap).",
          },
          path: {
            ...FILE_PATH_SCHEMA,
            description:
              "File or directory (default: workspace root; absolute, ~/, or relative; external may ask approval).",
          },
          pattern: {
            description: "Ripgrep regex pattern.",
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
                  if (mode === "count") matchCount += occurrences;
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
        if (result.stopReason) {
          const reason =
            result.stopReason === "match-limit" && mode !== "content"
              ? "file-limit"
              : result.stopReason;
          const suggestion =
            mode === "content"
              ? " Use output_mode=files to list paths only."
              : "";
          notices.push(
            `Search incomplete: ${STOP_NOTICE[reason]} Narrow path, include, or pattern.${suggestion}`,
          );
        }
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
            ...(mode === "files" ? {} : { matchCount }),
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
