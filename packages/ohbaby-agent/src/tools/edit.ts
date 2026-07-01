import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { getBooleanParam, getStringParam } from "./utils/params.js";
import { renderUnifiedDiff, truncateOutput } from "./utils/output.js";
import { resolvePathForExisting } from "./utils/context.js";
import { findEditMatch } from "./utils/edit-match.js";
import { withFileLock } from "./utils/file-locks.js";
import {
  convertToLineEnding,
  FILE_PATH_SCHEMA,
  getDryRunParam,
  readTextFileContent,
  readWrittenFileMetadata,
  resolveWritableFile,
  withUtf8Bom,
  writeTextFileAtomic,
  type LineEnding,
} from "./utils/text-files.js";

function preferredEditLineEnding(lineEnding: LineEnding): LineEnding {
  return lineEnding === "CRLF" ? "CRLF" : "LF";
}

export function createEditTool(): Tool {
  return {
    name: "edit",
    description:
      "Replace unique text in the current contents of an existing file in the execution workspace. Exact old_string matches are preferred; bounded indentation and whitespace fuzzy matching is used only when exact matching fails. Whitespace fuzzy matching can treat runs of spaces, tabs, and newlines as equivalent inside a candidate, so include enough surrounding context for whitespace-sensitive edits.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        dry_run: { type: "boolean" },
        expected_mtime_ms: {
          deprecated: true,
          description:
            "Deprecated for edit; accepted for compatibility but content matching is authoritative.",
          type: "number",
        },
        file_path: FILE_PATH_SCHEMA,
        new_string: {
          description: "Replacement text.",
          type: "string",
        },
        old_string: {
          description:
            "Text to replace. Include enough surrounding context so the match is unique. Whitespace fuzzy matching may collapse spaces, tabs, and newlines inside a candidate when exact matching fails.",
          type: "string",
        },
        replace_all: {
          description:
            "Replace all exact old_string matches. Fuzzy matching is only used for single replacements.",
          type: "boolean",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const oldString = getStringParam(params, "old_string");
      const newString = getStringParam(params, "new_string", {
        allowEmpty: true,
      });
      const replaceAll = getBooleanParam(params, "replace_all", false);
      const dryRun = getDryRunParam(params);
      const existingPath = await resolvePathForExisting(context, inputPath);
      const writePath = await resolveWritableFile(context, inputPath);
      return await withFileLock(writePath, async () => {
        const file = await readTextFileContent(existingPath, inputPath);
        const editLineEnding = preferredEditLineEnding(file.lineEnding);
        const oldStringForFile = convertToLineEnding(oldString, editLineEnding);
        const newStringForFile = convertToLineEnding(newString, editLineEnding);
        const match = findEditMatch({
          content: file.text,
          oldString: oldStringForFile,
          replaceAll,
        });
        const replacementCount = match.replacementCount;
        const updated = replaceAll
          ? file.text.split(match.text).join(newStringForFile)
          : `${file.text.slice(0, match.start)}${newStringForFile}${file.text.slice(match.end)}`;
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
              sizeBytes: Buffer.byteLength(
                withUtf8Bom(updated, file.bom),
                "utf8",
              ),
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
      });
    },
  };
}
