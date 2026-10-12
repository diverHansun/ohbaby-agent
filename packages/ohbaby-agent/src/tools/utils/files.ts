import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionContext } from "../../core/tool-scheduler/index.js";
import { resolvePathForWrite } from "./context.js";

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
