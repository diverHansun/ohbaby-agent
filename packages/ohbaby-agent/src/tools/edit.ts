import type { Tool, ToolExecutionResult } from "../core/tool-scheduler/index.js";
import { getBooleanParam, getStringParam, ToolParameterError } from "./utils/params.js";
import { renderUnifiedDiff, truncateOutput } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import { assertTextFileWasReadBeforeEdit } from "./utils/read-state.js";
import {
  assertExpectedMtimeMs,
  convertToLineEnding,
  FILE_PATH_SCHEMA,
  getDryRunParam,
  getExpectedMtimeMs,
  readTextFileContent,
  readWrittenFileMetadata,
  resolveWritableFile,
  withUtf8Bom,
  writeTextFileAtomic,
  type LineEnding,
} from "./utils/text-files.js";

function countOccurrences(content: string, target: string): number {
  return content.split(target).length - 1;
}

function preferredEditLineEnding(lineEnding: LineEnding): LineEnding {
  return lineEnding === "CRLF" ? "CRLF" : "LF";
}

export function createEditTool(): Tool {
  return {
    name: "edit",
    description: "Replace text in an existing workspace file.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        dry_run: { type: "boolean" },
        expected_mtime_ms: { type: "number" },
        file_path: FILE_PATH_SCHEMA,
        new_string: { type: "string" },
        old_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string", "expected_mtime_ms"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const oldString = getStringParam(params, "old_string");
      const newString = getStringParam(params, "new_string", { allowEmpty: true });
      const replaceAll = getBooleanParam(params, "replace_all", false);
      const dryRun = getDryRunParam(params);
      const expectedMtimeMs = getExpectedMtimeMs(params);
      const existingPath = await resolvePathForExisting(context, inputPath);
      const writePath = await resolveWritableFile(context, inputPath);
      const file = await readTextFileContent(existingPath, inputPath);
      assertExpectedMtimeMs(inputPath, file.mtimeMs, expectedMtimeMs);
      assertTextFileWasReadBeforeEdit({
        actualMtimeMs: file.mtimeMs,
        context,
        inputPath,
        resolvedPath: existingPath,
      });
      const editLineEnding = preferredEditLineEnding(file.lineEnding);
      const oldStringForFile = convertToLineEnding(oldString, editLineEnding);
      const newStringForFile = convertToLineEnding(newString, editLineEnding);
      const occurrences = countOccurrences(file.text, oldStringForFile);
      if (occurrences === 0) {
        throw new Error(`No occurrences found for edit target in ${inputPath}.`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new ToolParameterError(
          `Multiple occurrences found (${String(occurrences)}); set replace_all to true.`,
        );
      }
      const replacementCount = replaceAll ? occurrences : 1;
      const updated = replaceAll
        ? file.text.split(oldStringForFile).join(newStringForFile)
        : file.text.replace(oldStringForFile, newStringForFile);
      const diff = renderUnifiedDiff({
        after: updated,
        before: file.text,
      });
      if (dryRun) {
        return {
          output: truncateOutput(
            [
              "Dry run: no changes written.",
              `Replacements: ${String(replacementCount)}`,
              diff,
            ].join("\n"),
          ),
          metadata: {
            diff,
            dryRun: true,
            encoding: file.encoding,
            lineEnding: file.lineEnding,
            mtimeMs: file.mtimeMs,
            path: writePath,
            replacementCount,
            sizeBytes: Buffer.byteLength(withUtf8Bom(updated, file.bom), "utf8"),
          },
        };
      }
      await writeTextFileAtomic(writePath, withUtf8Bom(updated, file.bom));
      const written = await readWrittenFileMetadata(writePath);

      return {
        output: truncateOutput(
          [`Replacements: ${String(replacementCount)}`, diff].join("\n"),
        ),
        metadata: {
          diff,
          encoding: file.encoding,
          lineEnding: file.lineEnding,
          mtimeMs: written.mtimeMs,
          path: writePath,
          replacementCount,
          sizeBytes: written.sizeBytes,
        },
      };
    },
  };
}
