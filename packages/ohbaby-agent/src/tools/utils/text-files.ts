import { assertMutationBudget, EDIT_MAX_BYTES } from "./mutation-budgets.js";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext } from "../../core/tool-scheduler/index.js";
import {
  resolvePath,
  resolvePathForExisting,
  resolvePathForWrite,
} from "./context.js";
import { ensureWritableParent } from "./files.js";
import { ToolParameterError } from "./params.js";

export const DEFAULT_READ_LIMIT = 2_000;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_READ_LIMIT = 20_000;
export const MAX_SEARCH_VISITED_FILES = 10_000;
export const TEXT_FILE_SAMPLE_BYTES = 4_096;

export const FILE_PATH_SCHEMA = {
  type: "string",
  description:
    "Path inside the tool execution workspace. Relative paths and absolute paths within the workspace are supported.",
};

export type LineEnding = "CRLF" | "LF" | "mixed" | "none";

export interface TextFileContent {
  readonly bom: boolean;
  readonly encoding: "utf8";
  readonly lineEnding: LineEnding;
  readonly mtimeMs: number;
  readonly path: string;
  readonly sizeBytes: number;
  readonly text: string;
}

export class BinaryTextFileError extends Error {
  constructor(inputPath: string) {
    super(`Binary files cannot be read as text: ${inputPath}.`);
    this.name = "BinaryTextFileError";
  }
}

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".br",
  ".bz2",
  ".class",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lib",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".obj",
  ".otf",
  ".parquet",
  ".pdf",
  ".png",
  ".psd",
  ".pyc",
  ".pyo",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
]);

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function normalizeMtimeMs(mtimeMs: number): number {
  return mtimeMs;
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  );
}

function stripUtf8Bom(buffer: Buffer): {
  readonly bom: boolean;
  readonly textBuffer: Buffer;
} {
  if (!hasUtf8Bom(buffer)) {
    return { bom: false, textBuffer: buffer };
  }

  return { bom: true, textBuffer: buffer.subarray(3) };
}

function readExpectedMtimeMs(
  params: Record<string, unknown>,
): number | undefined {
  const value = params.expected_mtime_ms;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ToolParameterError(
      'Expected parameter "expected_mtime_ms" to be a number.',
    );
  }

  return normalizeMtimeMs(value);
}

function detectBinarySample(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  if (buffer.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / buffer.length > 0.3;
}

export function detectLineEnding(text: string): LineEnding {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      if (text[index - 1] === "\r") crlfCount += 1;
      else lfCount += 1;
    }
  }
  if (crlfCount === 0 && lfCount === 0) {
    return "none";
  }
  if (crlfCount > 0 && lfCount > 0) {
    return "mixed";
  }

  return crlfCount > 0 ? "CRLF" : "LF";
}

export function convertToLineEnding(
  text: string,
  lineEnding: LineEnding,
  budget?: { readonly label: string; readonly limit: number },
): string {
  if (budget) {
    let bytes = Buffer.byteLength(text);
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\r" && text[index + 1] === "\n") {
        if (lineEnding !== "CRLF") bytes -= 1;
        index += 1;
      } else if (
        lineEnding === "CRLF" &&
        (text[index] === "\r" || text[index] === "\n")
      )
        bytes += 1;
    }
    assertMutationBudget(budget.label, bytes, budget.limit);
  }
  const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  if (lineEnding === "CRLF") {
    return normalized.replace(/\n/gu, "\r\n");
  }

  return normalized;
}

export function withUtf8Bom(text: string, bom: boolean): string {
  if (!bom) {
    return text;
  }
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;

  return `\uFEFF${withoutBom}`;
}

export function isProbablyBinaryTextFile(
  filePath: string,
  sample: Buffer,
): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }

  return detectBinarySample(sample);
}

export function getExpectedMtimeMs(
  params: Record<string, unknown>,
): number | undefined {
  return readExpectedMtimeMs(params);
}

export function getDryRunParam(params: Record<string, unknown>): boolean {
  const value = params.dry_run ?? false;
  if (typeof value !== "boolean") {
    throw new ToolParameterError(
      'Expected parameter "dry_run" to be a boolean.',
    );
  }

  return value;
}

export function assertExpectedMtimeMs(
  inputPath: string,
  actualMtimeMs: number,
  expectedMtimeMs: number | undefined,
): void {
  if (expectedMtimeMs === undefined) {
    throw new ToolParameterError(
      `expected_mtime_ms is required when modifying existing file: ${inputPath}.`,
    );
  }
  if (normalizeMtimeMs(actualMtimeMs) !== normalizeMtimeMs(expectedMtimeMs)) {
    throw new Error(
      `File mtime mismatch for ${inputPath}: expected ${String(expectedMtimeMs)}, actual ${String(actualMtimeMs)}. Read the file again before modifying it.`,
    );
  }
}

export async function readTextFileContent(
  filePath: string,
  inputPath = filePath,
  signal?: AbortSignal,
): Promise<TextFileContent> {
  const buffer = await readBoundedFile(
    filePath,
    EDIT_MAX_BYTES,
    "Edit original",
    signal,
  );
  if (
    isProbablyBinaryTextFile(
      filePath,
      buffer.subarray(0, TEXT_FILE_SAMPLE_BYTES),
    )
  ) {
    throw new BinaryTextFileError(inputPath);
  }
  const stripped = stripUtf8Bom(buffer);
  const text = decodeUtf8(stripped.textBuffer);
  const stats = await fs.stat(filePath);
  return {
    bom: stripped.bom,
    encoding: "utf8",
    lineEnding: detectLineEnding(text),
    mtimeMs: stats.mtimeMs,
    path: filePath,
    sizeBytes: buffer.length,
    text,
  };
}

export function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    throw new Error(
      "File is not valid UTF-8. Use Bash with an explicit encoding if needed.",
    );
  }
}

async function openRegularFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ handle: FileHandle; stats: Stats }> {
  signal?.throwIfAborted();
  const beforeOpen = await fs.stat(filePath);
  if (!beforeOpen.isFile()) throw new Error(`Path is not a file: ${filePath}`);
  signal?.throwIfAborted();
  // A FIFO may replace the regular path between stat and open. On POSIX,
  // nonblocking open lets fstat reject it without waiting for an external writer.
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK;
  const handle = await fs.open(filePath, flags);
  try {
    signal?.throwIfAborted();
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Path is not a file: ${filePath}`);
    signal?.throwIfAborted();
    return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readBoundedFile(
  filePath: string,
  limit: number,
  label: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { handle, stats } = await openRegularFile(filePath, signal);
  try {
    assertMutationBudget(label, stats.size, limit);
    // A fixed capacity read also bounds allocation if the file grows after stat.
    const buffer = Buffer.alloc(Math.min(stats.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        Math.min(64 * 1024, buffer.length - offset),
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    assertMutationBudget(label, offset, limit);
    if (offset > stats.size)
      throw new Error("File changed while reading; retry the operation.");
    signal?.throwIfAborted();
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readWriteTargetHeader(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ bom: boolean; mtimeMs: number; sizeBytes: number }> {
  const { handle, stats } = await openRegularFile(filePath, signal);
  try {
    const header = Buffer.alloc(3);
    const { bytesRead } = await handle.read(header, 0, 3, 0);
    signal?.throwIfAborted();
    return {
      bom: hasUtf8Bom(header.subarray(0, bytesRead)),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
}

export async function resolveWritableFile(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string> {
  await ensureWritableParent(context, inputPath);
  const writePath = await resolvePathForWrite(context, inputPath);
  try {
    await fs.lstat(writePath);
    return await resolvePathForExisting(context, inputPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return writePath;
    }
    throw error;
  }
}

export async function resolveExistingFileIfPresent(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string | undefined> {
  try {
    return await resolvePathForExisting(context, inputPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveWritablePreview(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<string> {
  let candidate = inputPath;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(
        await resolvePathForWrite(context, candidate),
        ...suffix,
      );
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function resolvePreviewPath(
  context: ToolExecutionContext,
  inputPath: string,
): string {
  return resolvePath(context, inputPath);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function writeTextFileAtomic(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.ohbaby-tmp-${String(process.pid)}-${String(Date.now())}-${randomUUID()}-${path.basename(filePath)}`,
  );
  let cleanup = true;

  try {
    await fs.writeFile(tempPath, content, "utf8");
    try {
      const targetStats = await fs.stat(filePath);
      if (targetStats.isFile()) {
        await fs.chmod(tempPath, targetStats.mode);
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    signal?.throwIfAborted();
    await fs.rename(tempPath, filePath);
    cleanup = false;
  } finally {
    if (cleanup) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function readWrittenFileMetadata(filePath: string): Promise<{
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}> {
  const stats = await fs.stat(filePath);

  return {
    mtimeMs: normalizeMtimeMs(stats.mtimeMs),
    sizeBytes: stats.size,
  };
}

export async function readCommittedFileMetadata(
  filePath: string,
  knownSizeBytes: number,
): Promise<{
  readonly mtimeMs?: number;
  readonly sizeBytes: number;
  readonly metadataWarning?: string;
}> {
  try {
    return await readWrittenFileMetadata(filePath);
  } catch {
    return {
      sizeBytes: knownSizeBytes,
      metadataWarning: "Change committed; post-write metadata unavailable.",
    };
  }
}
