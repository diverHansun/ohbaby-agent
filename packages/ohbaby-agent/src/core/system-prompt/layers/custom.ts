import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CUSTOM_INSTRUCTIONS_FILE_NAME = "OHBABY.md";
export const PROJECT_CUSTOM_CONFIG_DIR = ".ohbaby-agent";
export const GLOBAL_CUSTOM_CONFIG_DIR = ".ohbaby-agent";
export const MAX_CUSTOM_INSTRUCTION_CHARS = 50 * 1024;

export interface CustomInstructionLoadOptions {
  readonly globalPath?: string;
  readonly homeDirectory?: string;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly projectDirectory?: string;
  readonly projectPath?: string;
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
    projectDirectory,
    PROJECT_CUSTOM_CONFIG_DIR,
    CUSTOM_INSTRUCTIONS_FILE_NAME,
  );
}

export function getGlobalCustomInstructionsPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    GLOBAL_CUSTOM_CONFIG_DIR,
    CUSTOM_INSTRUCTIONS_FILE_NAME,
  );
}

async function readInstructionFile(
  filePath: string,
  onWarning?: (message: string, error?: unknown) => void,
): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onWarning?.(`Unable to read custom instructions: ${filePath}`, error);
    }
    return undefined;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length > MAX_CUSTOM_INSTRUCTION_CHARS) {
    onWarning?.(`Custom instructions truncated: ${filePath}`);
    return trimmed.slice(0, MAX_CUSTOM_INSTRUCTION_CHARS);
  }

  return trimmed;
}

async function loadProjectInstructions(
  options: CustomInstructionLoadOptions,
): Promise<string | undefined> {
  if (options.projectPath) {
    return readInstructionFile(options.projectPath, options.onWarning);
  }

  const projectDirectory = options.projectDirectory ?? process.cwd();
  const rootInstructions = await readInstructionFile(
    getProjectCustomInstructionsPath(projectDirectory),
    options.onWarning,
  );
  if (rootInstructions !== undefined) {
    return rootInstructions;
  }

  return readInstructionFile(
    getProjectConfigCustomInstructionsPath(projectDirectory),
    options.onWarning,
  );
}

export async function loadCustomInstructions(
  options: CustomInstructionLoadOptions = {},
): Promise<string[]> {
  const globalPath =
    options.globalPath ??
    getGlobalCustomInstructionsPath(options.homeDirectory);
  const instructions = await Promise.all([
    loadProjectInstructions(options),
    readInstructionFile(globalPath, options.onWarning),
  ]);

  return instructions.filter(
    (instruction): instruction is string => instruction !== undefined,
  );
}

export function generateCustomInstructionsPrompt(
  instructions: readonly string[],
): string {
  if (instructions.length === 0) {
    return "";
  }

  const rendered = instructions
    .map((instruction, index) => `## Source ${String(index + 1)}\n${instruction}`)
    .join("\n\n");

  return `<custom_instructions>\n# Custom Instructions\n${rendered}\n</custom_instructions>`;
}
