import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { getStringParam } from "./utils/params.js";
import {
  assertMutationBudget,
  assertWellFormedUnicode,
  boundedDiff,
  diffPreviewMessage,
  omittedDiff,
  WRITE_MAX_BYTES,
  DIFF_INPUT_MAX_BYTES,
} from "./utils/mutation-budgets.js";
import { withFileLock } from "./utils/file-locks.js";
import {
  assertExpectedMtimeMs,
  detectLineEnding,
  FILE_PATH_SCHEMA,
  getDryRunParam,
  getExpectedMtimeMs,
  readCommittedFileMetadata,
  readWriteTargetHeader,
  readBoundedFile,
  decodeUtf8,
  resolveExistingFileIfPresent,
  resolveWritablePreview,
  resolveWritableFile,
  withUtf8Bom,
  writeTextFileAtomic,
} from "./utils/text-files.js";

export function createWriteTool(): Tool {
  return {
    name: "write",
    description:
      "Create a file or replace its entire contents with the supplied UTF-8 text (20 MiB write budget). Existing contents are fully replaced even if they are not valid UTF-8. The previous encoding is not preserved; an existing UTF-8 BOM is preserved. Input strings containing lone Unicode surrogates are rejected. Use Edit for targeted changes. Dry-run diffs have separate limits and may be omitted.",
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
      context.signal.throwIfAborted();
      assertMutationBudget(
        "Write content",
        Buffer.byteLength(content),
        WRITE_MAX_BYTES,
      );
      assertWellFormedUnicode(content, "Write content");
      const dryRun = getDryRunParam(params);
      const expectedMtimeMs = getExpectedMtimeMs(params);
      const resolvedPath = dryRun
        ? await resolveWritablePreview(context, inputPath)
        : await resolveWritableFile(context, inputPath);
      return await withFileLock(
        resolvedPath,
        async () => {
          // Re-resolve inside the lock so the mtime check observes the same file
          // state the write will replace.
          const lockedExistingPath = await resolveExistingFileIfPresent(
            context,
            inputPath,
          );
          const existed = lockedExistingPath !== undefined;
          const existing = existed
            ? await readWriteTargetHeader(lockedExistingPath, context.signal)
            : undefined;
          if (existing) {
            assertExpectedMtimeMs(inputPath, existing.mtimeMs, expectedMtimeMs);
          }
          assertMutationBudget(
            "Write content",
            Buffer.byteLength(content) +
              (existing?.bom && !content.startsWith("\uFEFF") ? 3 : 0),
            WRITE_MAX_BYTES,
          );
          const contentToWrite = withUtf8Bom(content, existing?.bom ?? false);
          assertMutationBudget(
            "Write content",
            Buffer.byteLength(contentToWrite),
            WRITE_MAX_BYTES,
          );
          context.signal.throwIfAborted();
          if (dryRun) {
            let preview;
            if (existing && lockedExistingPath) {
              if (
                existing.sizeBytes + Buffer.byteLength(content) >
                DIFF_INPUT_MAX_BYTES
              ) {
                preview = omittedDiff(
                  `combined input exceeds ${String(DIFF_INPUT_MAX_BYTES)} bytes`,
                );
              } else {
                try {
                  const oldBytes = await readBoundedFile(
                    lockedExistingPath,
                    DIFF_INPUT_MAX_BYTES,
                    "Diff input",
                    context.signal,
                  );
                  if (oldBytes.includes(0))
                    preview = omittedDiff("old contents are binary");
                  else
                    preview = boundedDiff(
                      decodeUtf8(oldBytes).replace(/^\uFEFF/u, ""),
                      content,
                    );
                } catch (error) {
                  context.signal.throwIfAborted();
                  preview = omittedDiff(
                    error instanceof Error
                      ? error.message
                      : "old contents unavailable",
                  );
                }
              }
            } else preview = boundedDiff("", content);
            const diff = diffPreviewMessage(preview);
            const bytes = Buffer.byteLength(contentToWrite, "utf8");

            return {
              output: ["Dry run: no changes written.", diff].join("\n"),
              metadata: {
                bytes,
                created: !existed,
                ...preview,
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
          await writeTextFileAtomic(
            resolvedPath,
            contentToWrite,
            context.signal,
          );
          const written = await readCommittedFileMetadata(
            resolvedPath,
            Buffer.byteLength(contentToWrite),
          );
          const bytes = Buffer.byteLength(contentToWrite, "utf8");

          return {
            output: [
              `Wrote ${String(bytes)} bytes to ${inputPath}.`,
              written.metadataWarning,
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              bytes,
              created: !existed,
              encoding: "utf8",
              lineEnding: detectLineEnding(content),
              mtimeMs: written.mtimeMs,
              ...(written.metadataWarning
                ? { metadataWarning: written.metadataWarning }
                : {}),
              path: resolvedPath,
              sizeBytes: written.sizeBytes,
            },
          };
        },
        { signal: context.signal },
      );
    },
  };
}
