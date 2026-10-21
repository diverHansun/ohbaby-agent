import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultWorkspaceBoundary,
  isSameCanonicalDirectory,
} from "../../../paths/index.js";
import type { EnvironmentInfo } from "../types.js";

export interface EnvironmentDetectionOptions {
  readonly isGitRepo?: (directory: string) => boolean | Promise<boolean>;
  readonly now?: () => Date;
  readonly osVersion?: () => string;
  readonly platform?: NodeJS.Platform;
}

export interface GenerateEnvironmentPromptOptions {
  readonly info: EnvironmentInfo;
  readonly minimal: boolean;
}

function escapeBoundaryValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatEnvironmentDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function defaultIsGitRepo(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  const boundary = defaultWorkspaceBoundary(current);

  for (;;) {
    try {
      await fs.access(path.join(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      // A missing .git entry may still belong to a repository higher up.
    }
    if (boundary !== undefined && isSameCanonicalDirectory(current, boundary)) {
      return false;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export async function detectEnvironment(
  directory = process.cwd(),
  options: EnvironmentDetectionOptions = {},
): Promise<EnvironmentInfo> {
  const cwd = path.resolve(directory);
  const isGitRepo = await (options.isGitRepo ?? defaultIsGitRepo)(cwd);
  const osVersion = options.osVersion?.() ?? os.version();

  return {
    cwd,
    platform: options.platform ?? process.platform,
    date: formatEnvironmentDate((options.now ?? ((): Date => new Date()))()),
    isGitRepo,
    ...(osVersion.trim() === "" ? {} : { osVersion }),
  };
}

export function generateEnvironmentPrompt(
  options: GenerateEnvironmentPromptOptions,
): string {
  const lines = [
    "<environment_context>",
    `Current working directory: ${escapeBoundaryValue(options.info.cwd)}`,
    `Platform: ${escapeBoundaryValue(options.info.platform)}`,
    `Date: ${escapeBoundaryValue(options.info.date)}`,
    `Git repository: ${String(options.info.isGitRepo)}`,
  ];

  if (!options.minimal && options.info.osVersion) {
    lines.splice(
      3,
      0,
      `OS version: ${escapeBoundaryValue(options.info.osVersion)}`,
    );
  }

  lines.push("</environment_context>");
  return lines.join("\n");
}
