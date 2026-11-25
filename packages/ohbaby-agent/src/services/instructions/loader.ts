import { hash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
} from "../../core/system-prompt/security/index.js";
import { resolveOhbabyHome } from "../../paths/index.js";
import type {
  InstructionSource,
  InstructionWarning,
  LastGoodRead,
  LoadInstructionsOptions,
} from "./types.js";

const fileNames = ["AGENTS.md", "CLAUDE.md"] as const;
type Scope = InstructionSource["scope"];
type FileName = InstructionSource["fileName"];

function decode(bytes: Buffer, atReadLimit: boolean): string | undefined {
  // A BOM fixes the encoding; only BOM-less files fall back to GB18030.
  let encodings: string[];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encodings = ["utf-16le"];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encodings = ["utf-16be"];
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    encodings = ["utf-8"];
  else encodings = ["utf-8", "gb18030"];
  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes, {
        stream: atReadLimit,
      });
    } catch {
      // Invalid in this encoding. At EOF an incomplete character is invalid too.
    }
  }
  return undefined;
}

function clip(text: string, maxBytes: number): LastGoodRead {
  if (Buffer.byteLength(text) <= maxBytes)
    return { content: text.trim(), truncated: false };
  // Streaming decode leaves an incomplete final UTF-8 character out.
  const prefix = Buffer.from(text).subarray(0, maxBytes);
  const content = new TextDecoder().decode(prefix, { stream: true }).trim();
  return { content, truncated: true };
}

async function isSiblingAlias(file: string, name: FileName): Promise<boolean> {
  const sibling = name === "AGENTS.md" ? "CLAUDE.md" : "AGENTS.md";
  try {
    return (
      (await fs.readlink(file)) === sibling &&
      (await fs.lstat(path.join(path.dirname(file), sibling))).isFile()
    );
  } catch {
    return false;
  }
}

async function readCandidate(
  scope: Scope,
  fileName: FileName,
  file: string,
  options: LoadInstructionsOptions,
): Promise<LastGoodRead | undefined> {
  function reject(code: string, message: string): void {
    options.onWarning?.({ sourcePath: file, kind: "rejected", code, message });
  }

  const stat = scope === "project" ? await fs.lstat(file) : await fs.stat(file);
  if (stat.isSymbolicLink()) {
    if (await isSiblingAlias(file, fileName)) return undefined;
    reject(
      "PROJECT_SYMLINK",
      "Symbolic links are not accepted for project instructions.",
    );
    return undefined;
  }
  if (!stat.isFile()) {
    reject("NOT_REGULAR_FILE", "Instructions must be a regular file.");
    return undefined;
  }

  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY |
        constants.O_NONBLOCK |
        (scope === "project" ? constants.O_NOFOLLOW : 0);
  const handle = await fs.open(file, flags);
  try {
    if (!(await handle.stat()).isFile()) {
      reject("NOT_REGULAR_FILE", "Instructions must be a regular file.");
      return undefined;
    }
    const maxBytes = options.maxFileBytes ?? 32 * 1024;
    // Up to two source bytes per UTF-8 byte, plus room for a BOM and a partial character.
    const bytes = Buffer.allocUnsafe(2 * maxBytes + 8);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const text = decode(bytes.subarray(0, used), used === bytes.length);
    if (text === undefined) {
      reject(
        "INVALID_ENCODING",
        "Instructions use an invalid or unsupported text encoding.",
      );
      return undefined;
    }
    const read = clip(text, maxBytes);
    return read.content ? read : undefined;
  } finally {
    await handle.close();
  }
}

async function loadCandidate(
  scope: Scope,
  directory: string,
  fileName: FileName,
  options: LoadInstructionsOptions,
): Promise<InstructionSource | undefined> {
  const file = path.resolve(directory, fileName);
  let read: LastGoodRead | undefined;
  try {
    read = await readCandidate(scope, fileName, file, options);
    if (read) options.lastGoodReads?.set(file, read);
    else options.lastGoodReads?.delete(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "READ_ERROR";
    if (code === "ENOENT" || code === "ENOTDIR") {
      options.lastGoodReads?.delete(file);
      return undefined;
    }
    options.onWarning?.({
      sourcePath: file,
      kind: "read-error",
      code,
      message: `Unable to read instructions: ${code}.`,
    });
    read = options.lastGoodReads?.get(file);
  }

  if (!read) return undefined;
  if (read.truncated)
    options.onWarning?.({
      sourcePath: file,
      kind: "truncated",
      code: "FILE_LIMIT",
      message: "Instructions exceed the per-file size limit.",
    });
  const scan = (options.securityScanner ?? scanPromptLikeContent)(
    read.content,
    {
      kind: "custom-instructions",
      label: fileName,
      path: file,
    },
  );
  for (const finding of scan.findings) options.onSecurityFinding?.(finding);
  if (!shouldLoadPromptLikeContent(scan)) return undefined;
  return {
    ...read,
    fileName,
    scope,
    path: file,
    displayPath: `${scope}/${fileName}`,
    contentHash: hash("sha256", read.content),
  };
}

export async function loadInstructions(
  options: LoadInstructionsOptions = {},
): Promise<readonly InstructionSource[]> {
  let globalDirectory: string | undefined;
  try {
    globalDirectory = resolveOhbabyHome({
      homeDirectory: options.homeDirectory,
    });
  } catch (error) {
    options.onWarning?.({
      sourcePath: "global",
      kind: "read-error",
      code: "HOME_UNRESOLVED",
      message: (error as Error).message,
    });
  }
  // Budget and deduplicate in priority order; present global defaults first.
  const directories = [
    ["project", options.projectDirectory],
    ["global", globalDirectory],
  ] as const;
  const candidates = await Promise.all(
    directories.flatMap(([scope, directory]) =>
      directory
        ? fileNames.map((name) =>
            loadCandidate(scope, directory, name, options),
          )
        : [],
    ),
  );
  const seen = new Set<string>();
  const sources: InstructionSource[] = [];
  let remaining = options.maxTotalBytes ?? 64 * 1024;
  for (const source of candidates) {
    if (!source || seen.has(source.contentHash)) continue;
    seen.add(source.contentHash);
    const visible = clip(source.content, remaining);
    if (visible.truncated) {
      const warning: InstructionWarning = {
        sourcePath: source.path,
        kind: visible.content ? "truncated" : "budget-omitted",
        code: "TOTAL_LIMIT",
        message: visible.content
          ? "Instructions truncated to fit the total size limit."
          : "Instructions omitted at the total size limit.",
      };
      options.onWarning?.(warning);
      if (!visible.content) continue;
      sources.push({
        ...source,
        ...visible,
        contentHash: hash("sha256", visible.content),
      });
    } else {
      sources.push(source);
    }
    remaining -= Buffer.byteLength(visible.content);
  }
  return sources.sort(
    (a, b) => Number(a.scope === "project") - Number(b.scope === "project"),
  );
}
