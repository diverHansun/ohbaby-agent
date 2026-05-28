import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext } from "../../core/tool-scheduler/index.js";
import { resolvePathForWrite } from "./context.js";

export const DEFAULT_IGNORES = new Set([
  ".git",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export interface WalkFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface ScanFilesResult {
  readonly truncated: boolean;
  readonly visitedFileCount: number;
}

export type WalkFileVisitor = (
  file: WalkFile,
) => Promise<boolean | undefined> | boolean | undefined;

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function splitTextLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export function createGlobMatcher(
  pattern: string,
): (relativePath: string) => boolean {
  const normalized = normalizeRelativePath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  source += "$";
  const regex = new RegExp(source, "u");

  return (relativePath) => regex.test(normalizeRelativePath(relativePath));
}

export async function ensureWritableParent(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<void> {
  try {
    const resolvedTarget = await resolvePathForWrite(context, inputPath);
    await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
    return;
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const parent = path.dirname(inputPath);
  await ensureWritableDirectory(context, parent);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function ensureWritableDirectory(
  context: ToolExecutionContext,
  inputPath: string,
): Promise<void> {
  if (
    inputPath === "." ||
    inputPath === "" ||
    inputPath === path.dirname(inputPath)
  ) {
    return;
  }

  let resolved: string;
  try {
    resolved = await resolvePathForWrite(context, inputPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      await ensureWritableDirectory(context, path.dirname(inputPath));
      resolved = await resolvePathForWrite(context, inputPath);
    } else {
      throw error;
    }
  }

  await fs.mkdir(resolved).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }
    throw error;
  });
}

export async function walkFiles(input: {
  readonly basePath: string;
  readonly ignoreNames?: readonly string[];
  readonly limit?: number;
}): Promise<{ readonly files: WalkFile[]; readonly truncated: boolean }> {
  const ignored = new Set([...DEFAULT_IGNORES, ...(input.ignoreNames ?? [])]);
  const files: WalkFile[] = [];
  const limit = input.limit ?? Number.POSITIVE_INFINITY;
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        if (truncated) {
          return;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        absolutePath,
        relativePath: normalizeRelativePath(
          path.relative(input.basePath, absolutePath),
        ),
      });
      if (files.length >= limit) {
        truncated = true;
        return;
      }
    }
  }

  await visit(input.basePath);

  return { files, truncated };
}

export async function scanFiles(input: {
  readonly basePath: string;
  readonly ignoreNames?: readonly string[];
  readonly maxVisitedFiles?: number;
  readonly visit: WalkFileVisitor;
}): Promise<ScanFilesResult> {
  const ignored = new Set([...DEFAULT_IGNORES, ...(input.ignoreNames ?? [])]);
  const maxVisitedFiles = input.maxVisitedFiles ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  let visitedFileCount = 0;

  async function visitDirectory(directory: string): Promise<boolean> {
    if (truncated) {
      return false;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const keepGoing = await visitDirectory(absolutePath);
        if (!keepGoing) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (visitedFileCount >= maxVisitedFiles) {
        truncated = true;
        return false;
      }
      visitedFileCount += 1;
      const keepGoing = await input.visit({
        absolutePath,
        relativePath: normalizeRelativePath(
          path.relative(input.basePath, absolutePath),
        ),
      });
      if (keepGoing === false) {
        return false;
      }
    }

    return true;
  }

  await visitDirectory(input.basePath);

  return { truncated, visitedFileCount };
}
