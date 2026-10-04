import { withFileAccess } from "./utils/file-access.js";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  getNumberParam,
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
const PREVIEW_OMITTED = " [preview omitted; use Read for full content]";

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
        "Locate matching lines with ripgrep's default regex syntax (no look-around or backreferences). Returns paths, line numbers and limited previews; use Read for full content. Directory searches honor project .gitignore/.ignore/.rgignore, include hidden files and exclude .git traversal; parent/global ignores are disabled. Explicit include uses rg glob precedence and can override ignores, but does not filter explicitly named files. Binary files and arbitrary encodings are not guaranteed; previews may be unavailable. Use Bash explicitly for other encodings or raw bytes. No pagination or export.",
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
        const include = getOptionalStringParam(params, "include");
        const inputPath = getOptionalStringParam(params, "path") ?? ".";
        const limit = getNumberParam(params, "limit", {
          defaultValue: DEFAULT_SEARCH_LIMIT,
          integer: true,
          min: 1,
        });
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
        const display = { limited: false };
        const result = await searchWithRipgrep({
          executablePath: resolveBundledRipgrepPath(),
          cwd: stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath),
          target: resolvedPath,
          pattern,
          include,
          signal: context.signal,
          onMatch(match) {
            const rendered = preview(match);
            const line = `${match.path}:${String(match.line)}: ${rendered.text}`;
            const cost = Buffer.byteLength(line) + 1;
            if (outputBytes + cost > OUTPUT_BYTES - NOTICE_RESERVE_BYTES)
              return "output-limit";
            matches.push(line);
            matchCount += match.matchCount;
            outputBytes += cost;
            display.limited ||= rendered.limited;
            return matches.length >= limit ? "match-limit" : undefined;
          },
        });
        const scanComplete = !result.stopReason && result.binaryFileCount === 0;
        const notices: string[] = [];
        if (result.stopReason)
          notices.push(
            `Search incomplete: ${STOP_NOTICE[result.stopReason]} Narrow path/include/pattern.`,
          );
        if (result.binaryFileCount)
          notices.push(
            `Search incomplete: binary detection stopped or suppressed content in ${String(result.binaryFileCount)} file(s). Binary contents are outside the text-search guarantee.`,
          );
        if (display.limited)
          notices.push(
            "Result display limited: some previews are omitted or unavailable. Use Read at the returned path and line for details (Read supports UTF-8).",
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
            count: matches.length,
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
