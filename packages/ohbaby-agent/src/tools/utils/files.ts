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

export function createGlobMatcher(pattern: string): (relativePath: string) => boolean {
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
  const parent = path.dirname(inputPath);
  if (parent === "." || parent === "") {
    return;
  }
  const parts = parent.split(/[\\/]+/u).filter(Boolean);
  let current = path.isAbsolute(parent) ? path.parse(parent).root : "";
  for (const part of parts) {
    current = current === "" ? part : path.join(current, part);
    const resolved = await resolvePathForWrite(context, current);
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
        relativePath: normalizeRelativePath(path.relative(input.basePath, absolutePath)),
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
