import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import type { ToolExecutionResult } from "../../core/tool-scheduler/index.js";
import { ToolParameterError } from "./params.js";
import {
  BinaryTextFileError,
  isProbablyBinaryTextFile,
  TEXT_FILE_SAMPLE_BYTES,
} from "./text-files.js";

export const MAX_READ_OUTPUT_BYTES = 50 * 1024;
export const MAX_READ_SCAN_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const CURSOR_MAX_BYTES = 2048;
// A fixed reserve bounds the complete output, including the opaque cursor and hints.
const BODY_BYTES = MAX_READ_OUTPUT_BYTES - CURSOR_MAX_BYTES - 256;
type Version = [string, string, string, string, string];
interface Cursor {
  v: 1;
  target: string;
  version: Version;
  position: number;
  line: number;
  partial: boolean;
}
function version(stats: BigIntStats): Version {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map(
    String,
  ) as Version;
}
function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function invalidCursor(): never {
  throw new ToolParameterError(
    "Invalid Read cursor. Pass the returned cursor unchanged.",
  );
}
function decode(value: string, target: string): Cursor {
  if (value.length > CURSOR_MAX_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value))
    invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null) invalidCursor();
  const c = parsed as Record<keyof Cursor, unknown>;
  if (
    c.v !== 1 ||
    c.target !== target ||
    !Array.isArray(c.version) ||
    c.version.length !== 5 ||
    !c.version.every(
      (part) => typeof part === "string" && /^-?\d{1,40}$/u.test(part),
    ) ||
    typeof c.position !== "number" ||
    !Number.isSafeInteger(c.position) ||
    c.position < 1 ||
    typeof c.line !== "number" ||
    !Number.isSafeInteger(c.line) ||
    c.line < 1 ||
    c.line > c.position + 1 ||
    typeof c.partial !== "boolean"
  )
    invalidCursor();
  // Rebuilding also rejects unknown keys, alternate JSON layouts, and noncanonical base64.
  const canonical: Cursor = {
    v: 1,
    target,
    version: c.version as Version,
    position: c.position,
    line: c.line,
    partial: c.partial,
  };
  if (encode(canonical) !== value) invalidCursor();
  return canonical;
}
function assertVersion(actual: BigIntStats, expected: Version): void {
  if (
    !actual.isFile() ||
    version(actual).some((part, i) => part !== expected[i])
  ) {
    throw new Error("File has changed. Read the file again before continuing.");
  }
}

/** Each call owns one handle; no file content or paging session survives the call. */
export async function readFilePage(options: {
  filePath: string;
  offset: number;
  limit: number;
  cursor?: string;
  signal: AbortSignal;
}): Promise<ToolExecutionResult> {
  const { filePath, offset, limit, signal } = options;
  signal.throwIfAborted();
  const target = createHash("sha256").update(filePath).digest("hex");
  const prior =
    options.cursor === undefined ? undefined : decode(options.cursor, target);
  const beforeOpen = await fs.stat(filePath, { bigint: true });
  if (!beforeOpen.isFile()) throw new Error(`Path is not a file: ${filePath}`);
  signal.throwIfAborted();
  // POSIX FIFOs can replace a checked regular file before open. O_NONBLOCK
  // prevents waiting for a writer so the opened-handle type check can reject it.
  // Windows has no POSIX FIFO paths and does not support this flag.
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK;
  const handle = await fs.open(filePath, flags);
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error(`Path is not a file: ${filePath}`);
    assertVersion(initial, version(beforeOpen));
    if (initial.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("File size exceeds the supported safe byte range.");
    const numericStats = await handle.stat();
    const size = Number(initial.size);
    const expected = version(initial);
    if (prior) assertVersion(initial, prior.version);
    assertVersion(await fs.stat(filePath, { bigint: true }), expected);
    if (prior && prior.position >= size) invalidCursor();
    if (isProbablyBinaryTextFile(filePath, Buffer.alloc(0)))
      throw new BinaryTextFileError(filePath);

    let position = prior?.position ?? 0;
    let line = prior?.line ?? 1;
    let partial = prior?.partial ?? false;
    let lastWasNewline = !partial;
    if (prior) {
      const boundary = Buffer.alloc(2);
      await handle.read(boundary, 0, 2, position - 1);
      if (
        (boundary[1] & 0xc0) === 0x80 ||
        (boundary[0] === 13 && boundary[1] === 10) ||
        (partial ? boundary[0] === 10 : boundary[0] !== 10)
      )
        invalidCursor();
    }
    let buffer: Buffer = Buffer.alloc(0);
    let index = 0;
    let readPosition = position;
    let scanned = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const rows: string[] = [];
    let bodyBytes = 0;
    let shownLineCount = 0;
    let current = "";
    let currentStarted = false;
    let sawLF = false;
    let sawCRLF = false;

    while (position < size) {
      if (buffer.length - index < 4 && readPosition < size) {
        signal.throwIfAborted();
        await setImmediate(undefined, { signal });
        const remaining = MAX_READ_SCAN_BYTES - scanned;
        if (remaining <= 0)
          throw new Error(
            "Read scan limit (64 MiB) exceeded. Use a returned cursor or a smaller offset.",
          );
        const fresh = Buffer.alloc(
          Math.min(CHUNK_BYTES, size - readPosition, remaining),
        );
        const { bytesRead } = await handle.read(
          fresh,
          0,
          fresh.length,
          readPosition,
        );
        if (bytesRead === 0)
          throw new Error(
            "File has changed. Read the file again before continuing.",
          );
        const bytes = fresh.subarray(0, bytesRead);
        // The ratio heuristic belongs to the initial file sample, not arbitrary
        // I/O chunks or cursor positions. A short control-character tail is text.
        // Later blocks still reject NUL and undergo strict UTF-8 validation.
        if (
          bytes.includes(0) ||
          (readPosition === 0 &&
            isProbablyBinaryTextFile(
              filePath,
              bytes.subarray(0, TEXT_FILE_SAMPLE_BYTES),
            ))
        )
          throw new BinaryTextFileError(filePath);
        try {
          decoder.decode(bytes, { stream: true });
          if (readPosition + bytesRead === size) decoder.decode();
        } catch {
          throw new Error(`Invalid UTF-8 text: ${filePath}.`);
        }
        buffer = Buffer.concat([buffer.subarray(index), bytes]);
        index = 0;
        readPosition += bytesRead;
        scanned += bytesRead;
      }
      if (
        position === 0 &&
        buffer[0] === 0xef &&
        buffer[1] === 0xbb &&
        buffer[2] === 0xbf
      ) {
        position += 3;
        index += 3;
        continue;
      }
      const first = buffer[index];
      let width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      const newline =
        first === 10 || (first === 13 && buffer[index + 1] === 10);
      if (newline && first === 13) width = 2;
      if (buffer.length - index < width) {
        // A scan cap may fall inside a code point; never consume a partial character.
        throw new Error(
          "Read scan limit (64 MiB) exceeded. Use a returned cursor or a smaller offset.",
        );
      }
      if (line >= offset || prior) {
        if (!currentStarted) {
          if (shownLineCount >= limit) break;
          const prefix = `${String(line)}${partial ? " [continued]" : ""}: `;
          if (bodyBytes + Buffer.byteLength(prefix) + 5 > BODY_BYTES) break;
          current = prefix;
          bodyBytes += Buffer.byteLength(prefix) + (rows.length ? 1 : 0);
          currentStarted = true;
          shownLineCount += 1;
        }
        if (!newline) {
          if (bodyBytes + width > BODY_BYTES) break;
          current += buffer.subarray(index, index + width).toString("utf8");
          bodyBytes += width;
        }
      }
      index += width;
      position += width;
      lastWasNewline = newline;
      if (newline) {
        if (first === 13) sawCRLF = true;
        else sawLF = true;
        if (currentStarted) {
          rows.push(current);
          current = "";
          currentStarted = false;
        }
        line += 1;
        partial = false;
        if (shownLineCount >= limit) break;
      } else {
        partial = true;
      }
    }
    if (currentStarted) rows.push(current);
    signal.throwIfAborted();
    assertVersion(await handle.stat({ bigint: true }), expected);
    assertVersion(await fs.stat(filePath, { bigint: true }), expected);
    const hasMore = position < size;
    const nextCursor = hasMore
      ? encode({ v: 1, target, version: expected, position, line, partial })
      : undefined;
    const output =
      rows.join("\n") +
      (nextCursor
        ? `\n\n[More content${partial ? "; current line is partial" : ""}. Continue with cursor: ${nextCursor}]`
        : "");
    return {
      output,
      metadata: {
        encoding: "utf8",
        hasMore,
        ...(!hasMore ? { lineCount: lastWasNewline ? line - 1 : line } : {}),
        // This describes the scanned range; global line endings are unknown until EOF.
        lineEnding:
          sawLF && sawCRLF ? "mixed" : sawCRLF ? "CRLF" : sawLF ? "LF" : "none",
        lineEndingScope: "scanned",
        mtimeMs: numericStats.mtimeMs,
        nextCursor,
        nextOffset: hasMore ? line : undefined,
        path: filePath,
        shownLineCount,
        sizeBytes: size,
      },
    };
  } finally {
    await handle.close();
  }
}
