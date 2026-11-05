import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/types.js";
import {
  InvalidSessionStorageIdError,
  resolveSessionStorageDir,
  SCRATCH_DIR,
  TOOL_RESULTS_DIR,
} from "../paths/session-storage.js";
import { resolveOhbabyHome } from "../paths/ohbaby-home.js";
import { isProbablyBinaryTextFile } from "../tools/utils/text-files.js";
import {
  CappedOutputFile,
  type OutputFileSnapshot,
} from "../utils/capped-output-file.js";

/** Use the already prepared owner root; execution session IDs can belong to a child. */
export async function prepareToolOutputDirectory(
  environment?: Pick<ToolExecutionEnvironment, "trustedRoots">,
): Promise<string | undefined> {
  try {
    const root = environment
      ?.trustedRoots?.()
      .find((root) => root.kind === "session-storage")?.path;
    if (
      !root ||
      !(await fs.lstat(root)).isDirectory() ||
      (await fs.realpath(root)) !== root
    )
      return undefined;
    const directory = path.join(root, TOOL_RESULTS_DIR);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    });
    return await validate(directory);
  } catch {
    return undefined;
  }
  async function validate(directory: string): Promise<string | undefined> {
    if (
      !(await fs.lstat(directory)).isDirectory() ||
      (await fs.realpath(directory)) !== directory
    )
      return undefined;
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
    return directory;
  }
}

export async function writeToolOutput(input: {
  readonly environment?: Pick<ToolExecutionEnvironment, "trustedRoots">;
  readonly callId: string;
  readonly text: string;
}): Promise<OutputFileSnapshot> {
  const directory = await prepareToolOutputDirectory(input.environment);
  if (!directory) return { status: "unavailable" };
  const stem =
    input.callId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128) || "call";
  const file = new CappedOutputFile(
    path.join(directory, `${stem}-${randomUUID()}.txt`),
  );
  file.append(Buffer.from(input.text, "utf8"));
  file.finish(true);
  return file.snapshot();
}

export const SESSION_TEXT_FILE_MAX_BYTES = 1024 * 1024;
export const SESSION_IMAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface SessionFileEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}
export type SessionFileContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly contentType: string;
      readonly bytes: Uint8Array<ArrayBuffer>;
    };
export type SessionFileErrorCode =
  | "INVALID_PATH"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE";

export class SessionFileError extends Error {
  constructor(
    readonly code: SessionFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionFileError";
  }
}

function fileError(error: unknown): never {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === "ENOENT")
    throw new SessionFileError("FILE_NOT_FOUND", "Session file not found");
  if (
    error instanceof InvalidSessionStorageIdError ||
    code === "ELOOP" ||
    code === "ENOTDIR"
  )
    throw new SessionFileError("INVALID_PATH", "Invalid session file path");
  throw error;
}

function invalidPath(): never {
  throw new SessionFileError(
    "INVALID_PATH",
    "Session file path is redirected or is not a regular file",
  );
}

/** Canonicalize the configured home alias, but never accept redirects below it. */
async function sessionScratch(ownerSessionId: string): Promise<string> {
  resolveSessionStorageDir(ownerSessionId);
  let current = await fs.realpath(resolveOhbabyHome());
  for (const part of ["sessions", ownerSessionId, SCRATCH_DIR]) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || (await fs.realpath(current)) !== current)
      invalidPath();
  }
  return current;
}

function relativeFilePath(relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath) ||
    path.win32.parse(relativePath).root ||
    relativePath.split("/").includes("..")
  )
    throw new SessionFileError(
      "INVALID_PATH",
      "Expected a nonempty relative file path without traversal",
    );
  const normalized = path.posix.normalize(relativePath);
  if (normalized === ".") invalidPath();
  return normalized;
}

async function scratchEntry(
  scratch: string,
  relativePath: string,
): Promise<Stats> {
  let current = scratch;
  const parts = relativePath.split("/");
  let stats = await fs.lstat(current);
  for (const [index, part] of parts.entries()) {
    if (!stats.isDirectory()) invalidPath();
    current = path.join(current, part);
    stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || (await fs.realpath(current)) !== current)
      invalidPath();
    if (index < parts.length - 1 && !stats.isDirectory()) invalidPath();
  }
  return stats;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function listSessionFiles(
  ownerSessionId: string,
  signal?: AbortSignal,
): Promise<readonly SessionFileEntry[]> {
  try {
    signal?.throwIfAborted();
    let scratch: string;
    try {
      scratch = await sessionScratch(ownerSessionId);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    }
    const files: SessionFileEntry[] = [];
    async function visit(
      directory: string,
      relativeDirectory: string,
    ): Promise<void> {
      signal?.throwIfAborted();
      const before = await fs.lstat(directory);
      if (!before.isDirectory() || (await fs.realpath(directory)) !== directory)
        invalidPath();
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        signal?.throwIfAborted();
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
          continue;
        const relative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const stats = await scratchEntry(scratch, relative);
        if (stats.isDirectory())
          await visit(path.join(scratch, relative), relative);
        else if (stats.isFile())
          files.push({
            path: relative,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          });
        else invalidPath();
      }
      if (
        !sameFile(before, await fs.lstat(directory)) ||
        (await fs.realpath(directory)) !== directory
      )
        invalidPath();
    }
    await visit(scratch, "");
    if ((await sessionScratch(ownerSessionId)) !== scratch) invalidPath();
    signal?.throwIfAborted();
    return files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  } catch (error) {
    fileError(error);
  }
}

function imageContentType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  const gif = bytes.subarray(0, 6).toString("latin1");
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export async function readSessionFile(
  ownerSessionId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<SessionFileContent> {
  try {
    const relative = relativeFilePath(relativePath);
    signal?.throwIfAborted();
    const scratch = await sessionScratch(ownerSessionId);
    const before = await scratchEntry(scratch, relative);
    if (!before.isFile()) invalidPath();
    const target = path.resolve(scratch, relative);
    const fromScratch = path.relative(scratch, target);
    if (
      fromScratch === ".." ||
      fromScratch.startsWith(`..${path.sep}`) ||
      path.isAbsolute(fromScratch) ||
      !fromScratch
    )
      invalidPath();
    // Like bounded tool reads, nonblocking open avoids hanging if replaced with a FIFO.
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    const handle = await fs.open(target, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened)) invalidPath();
      const header = Buffer.alloc(12);
      let headerBytes = 0;
      while (headerBytes < header.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          header,
          headerBytes,
          header.length - headerBytes,
          headerBytes,
        );
        if (!bytesRead) break;
        headerBytes += bytesRead;
      }
      const contentType = imageContentType(header.subarray(0, headerBytes));
      const limit = contentType
        ? SESSION_IMAGE_FILE_MAX_BYTES
        : SESSION_TEXT_FILE_MAX_BYTES;
      if (opened.size > limit)
        throw new SessionFileError(
          "FILE_TOO_LARGE",
          "Session file exceeds its read limit",
        );
      // Fixed capacity also bounds actual reads when the file grows after fstat.
      const buffer = Buffer.alloc(limit + 1);
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
      if (offset > limit)
        throw new SessionFileError(
          "FILE_TOO_LARGE",
          "Session file exceeds its read limit",
        );
      if ((await sessionScratch(ownerSessionId)) !== scratch) invalidPath();
      const after = await scratchEntry(scratch, relative);
      if (
        !after.isFile() ||
        !sameFile(opened, after) ||
        !sameFile(opened, await handle.stat())
      )
        invalidPath();
      signal?.throwIfAborted();
      const bytes = buffer.subarray(0, offset);
      // A changing header must never turn unrelated bytes into an image response.
      if (contentType && imageContentType(bytes) === contentType)
        return { kind: "image", contentType, bytes };
      if (contentType || isProbablyBinaryTextFile(relative, bytes))
        throw new SessionFileError(
          "UNSUPPORTED_FILE_TYPE",
          "Session file type is unsupported",
        );
      try {
        return {
          kind: "text",
          text: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
        };
      } catch {
        throw new SessionFileError(
          "UNSUPPORTED_FILE_TYPE",
          "Session file is not valid UTF-8",
        );
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    fileError(error);
  }
}
