import fs from "node:fs/promises";
import path from "node:path";
import {
  OHBABY_DIR_NAME,
  resolveLegacyGlobalMemoryPath,
  resolveLegacyOhbabyHome,
  resolveLegacyProjectOhbabyRoot,
  resolveOhbabyHome,
  resolveProjectOhbabyRoot,
} from "../../../paths/index.js";

import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
} from "../security/index.js";
import type {
  PromptSecurityFinding,
  PromptSecurityScanResult,
  PromptSecuritySource,
} from "../security/index.js";

export const CUSTOM_INSTRUCTIONS_FILE_NAME = "OHBABY.md";
export const CUSTOM_INSTRUCTIONS_FALLBACK_FILE_NAMES = [
  "OHBABY.md",
  "AGENTS.md",
  "CLAUDE.md",
] as const;
export const PROJECT_CUSTOM_CONFIG_DIR = OHBABY_DIR_NAME;
export const GLOBAL_CUSTOM_CONFIG_DIR = OHBABY_DIR_NAME;
export const MAX_CUSTOM_INSTRUCTION_CHARS = 50 * 1024;

export interface CustomInstructionLoadOptions {
  readonly globalPath?: string;
  readonly homeDirectory?: string;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly projectDirectory?: string;
  readonly projectPath?: string;
  readonly securityScanner?: (
    content: string,
    source: PromptSecuritySource,
  ) => PromptSecurityScanResult;
}

interface ReadInstructionFileOptions {
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly securityScanner?: (
    content: string,
    source: PromptSecuritySource,
  ) => PromptSecurityScanResult;
}

export function getProjectCustomInstructionsPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(projectDirectory, CUSTOM_INSTRUCTIONS_FILE_NAME);
}

export function getProjectConfigCustomInstructionsPath(
  projectDirectory = process.cwd(),
): string {
  return path.join(
    resolveProjectOhbabyRoot(projectDirectory),
    CUSTOM_INSTRUCTIONS_FILE_NAME,
  );
}

export function getGlobalCustomInstructionsPath(
  homeDirectory?: string,
): string {
  return path.join(
    resolveOhbabyHome({ homeDirectory }),
    CUSTOM_INSTRUCTIONS_FILE_NAME,
  );
}

function getCandidatePaths(directory: string): string[] {
  return CUSTOM_INSTRUCTIONS_FALLBACK_FILE_NAMES.map((fileName) =>
    path.join(directory, fileName),
  );
}

async function readInstructionFile(
  filePath: string,
  options: ReadInstructionFileOptions = {},
): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      options.onWarning?.(
        `Unable to read custom instructions: ${filePath}`,
        error,
      );
    }
    return undefined;
  }

  let instruction = content.trim();
  if (instruction.length === 0) {
    return undefined;
  }

  if (instruction.length > MAX_CUSTOM_INSTRUCTION_CHARS) {
    options.onWarning?.(`Custom instructions truncated: ${filePath}`);
    instruction = instruction.slice(0, MAX_CUSTOM_INSTRUCTION_CHARS);
  }

  const scan = options.securityScanner ?? scanPromptLikeContent;
  const scanResult = scan(instruction, {
    kind: "custom-instructions",
    label: path.basename(filePath),
    path: filePath,
  });
  for (const finding of scanResult.findings) {
    options.onSecurityFinding?.(finding);
  }

  if (!shouldLoadPromptLikeContent(scanResult)) {
    options.onWarning?.(
      `Custom instructions omitted by security guard: ${filePath}`,
    );
    return undefined;
  }

  return instruction;
}

async function readFirstInstructionFile(
  filePaths: readonly string[],
  options: ReadInstructionFileOptions = {},
): Promise<string | undefined> {
  for (const filePath of filePaths) {
    const instruction = await readInstructionFile(filePath, options);
    if (instruction !== undefined) {
      return instruction;
    }
  }
  return undefined;
}

async function loadProjectInstructions(
  options: CustomInstructionLoadOptions,
): Promise<string | undefined> {
  if (options.projectPath) {
    return readInstructionFile(options.projectPath, options);
  }

  const projectDirectory = options.projectDirectory ?? process.cwd();
  const rootInstructions = await readFirstInstructionFile(
    getCandidatePaths(projectDirectory),
    options,
  );
  if (rootInstructions !== undefined) {
    return rootInstructions;
  }

  return readFirstInstructionFile(
    [
      ...getCandidatePaths(
        path.join(projectDirectory, PROJECT_CUSTOM_CONFIG_DIR),
      ),
      ...getCandidatePaths(resolveLegacyProjectOhbabyRoot(projectDirectory)),
    ],
    options,
  );
}

export async function loadCustomInstructions(
  options: CustomInstructionLoadOptions = {},
): Promise<string[]> {
  const globalPath =
    options.globalPath ??
    getGlobalCustomInstructionsPath(options.homeDirectory);
  const globalPaths =
    options.globalPath !== undefined
      ? [globalPath]
      : [
          ...getCandidatePaths(
            path.dirname(
              getGlobalCustomInstructionsPath(options.homeDirectory),
            ),
          ),
          ...getCandidatePaths(
            resolveLegacyOhbabyHome({
              ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            }),
          ),
          resolveLegacyGlobalMemoryPath({
            ...(options.homeDirectory === undefined
              ? {}
              : { homeDirectory: options.homeDirectory }),
          }),
        ];
  const instructions = await Promise.all([
    loadProjectInstructions(options),
    readFirstInstructionFile(globalPaths, options),
  ]);

  return instructions.filter(
    (instruction): instruction is string => instruction !== undefined,
  );
}
