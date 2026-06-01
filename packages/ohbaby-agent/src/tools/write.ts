import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { getStringParam } from "./utils/params.js";
import { renderUnifiedDiff, truncateOutput } from "./utils/output.js";
import { withFileLock } from "./utils/file-locks.js";
import {
  assertExpectedMtimeMs,
  detectLineEnding,
  FILE_PATH_SCHEMA,
  getDryRunParam,
  getExpectedMtimeMs,
  readWrittenFileMetadata,
  readTextFileContent,
  resolveExistingFileIfPresent,
  resolvePreviewPath,
  resolveWritableFile,
  withUtf8Bom,
  writeTextFileAtomic,
} from "./utils/text-files.js";

export function createWriteTool(): Tool {
  return {
    name: "write",
    description: "Write a text file inside the execution workspace.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        content: { type: "string" },
        dry_run: { type: "boolean" },
        expected_mtime_ms: { type: "number" },
        file_path: FILE_PATH_SCHEMA,
      },
      required: ["file_path", "content"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const inputPath = getStringParam(params, "file_path");
      const content = getStringParam(params, "content", { allowEmpty: true });
      const dryRun = getDryRunParam(params);
      const expectedMtimeMs = getExpectedMtimeMs(params);
      const existingPath = await resolveExistingFileIfPresent(
        context,
        inputPath,
      );
      const resolvedPath = dryRun
        ? (existingPath ?? resolvePreviewPath(context, inputPath))
        : await resolveWritableFile(context, inputPath);
      return await withFileLock(resolvedPath, async () => {
        const lockedExistingPath = await resolveExistingFileIfPresent(
          context,
          inputPath,
        );
        const existed = lockedExistingPath !== undefined;
        const existing = existed
          ? await readTextFileContent(lockedExistingPath, inputPath)
          : undefined;
        if (existing) {
          assertExpectedMtimeMs(inputPath, existing.mtimeMs, expectedMtimeMs);
        }
        const contentToWrite = withUtf8Bom(content, existing?.bom ?? false);
        const diff = renderUnifiedDiff({
          after: content,
          before: existing?.text ?? "",
        });
        if (dryRun) {
          const bytes = Buffer.byteLength(contentToWrite, "utf8");

          return {
            output: truncateOutput(
              ["Dry run: no changes written.", diff].join("\n"),
            ),
            metadata: {
              bytes,
              created: !existed,
              diff,
              dryRun: true,
              encoding: "utf8",
              lineEnding: detectLineEnding(content),
              mtimeMs: existing?.mtimeMs,
              path: resolvedPath,
              sizeBytes: bytes,
              wouldCreate: !existed,
            },
          };
        }
        await writeTextFileAtomic(resolvedPath, contentToWrite);
        const written = await readWrittenFileMetadata(resolvedPath);
        const bytes = Buffer.byteLength(contentToWrite, "utf8");

        return {
          output: `Wrote ${String(bytes)} bytes to ${inputPath}.`,
          metadata: {
            bytes,
            created: !existed,
            encoding: "utf8",
            lineEnding: detectLineEnding(content),
            mtimeMs: written.mtimeMs,
            path: resolvedPath,
            sizeBytes: written.sizeBytes,
          },
        };
      });
    },
  };
}
