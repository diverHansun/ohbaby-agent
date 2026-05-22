import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SkillLoadError } from "./errors.js";
import type {
  SkillContent,
  SkillInfo,
  SkillLoaderPort,
  SkillLogger,
  SkillScope,
  SkillSearchDirectory,
} from "./types.js";

const GLOBAL_CONFIG_DIR_NAME = "ohbaby-agent";
const PROJECT_CONFIG_DIR_NAME = ".ohbaby-agent";
const SKILL_DIR_NAME = "skill";
const SKILL_FILE_NAME = "SKILL.md";

const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u),
  description: z.string().min(1).max(1024),
  "user-invocable": z.boolean().optional().default(true),
  "disable-model-invocation": z.boolean().optional().default(false),
});

interface ParsedSkillFile {
  readonly data: z.infer<typeof SkillFrontmatterSchema>;
  readonly content: string;
}

export interface SkillLoaderOptions {
  readonly directories?: readonly SkillSearchDirectory[];
  readonly homeDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly projectDirectory?: string;
  readonly logger?: SkillLogger;
}

function defaultLogger(): SkillLogger {
  return {
    warn(): void {
      return undefined;
    },
  };
}

function getGlobalConfigRoot(
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (process.platform === "win32") {
    return (
      environment.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming")
    );
  }
  return environment.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config");
}

export function getGlobalSkillDirectory(
  homeDirectory = os.homedir(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(
    getGlobalConfigRoot(homeDirectory, environment),
    GLOBAL_CONFIG_DIR_NAME,
    SKILL_DIR_NAME,
  );
}

export function getProjectSkillDirectory(
  projectDirectory = process.cwd(),
): string {
  return path.join(projectDirectory, PROJECT_CONFIG_DIR_NAME, SKILL_DIR_NAME);
}

export function getDefaultSkillDirectories(
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly projectDirectory?: string;
  } = {},
): readonly SkillSearchDirectory[] {
  return [
    {
      path: getGlobalSkillDirectory(input.homeDirectory, input.environment),
      scope: "user",
    },
    {
      path: getProjectSkillDirectory(input.projectDirectory),
      scope: "project",
    },
  ];
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isHiddenRelativePath(value: string): boolean {
  return normalizeRelativePath(value)
    .split("/")
    .some((segment) => segment.startsWith("."));
}

async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function findSkillFiles(root: string): Promise<readonly string[]> {
  const rootStats = await lstatIfExists(root);
  if (!rootStats?.isDirectory()) {
    return [];
  }
  const rootRealPath = await fs.realpath(root).catch(() => path.resolve(root));
  const files: string[] = [];
  const visited = new Set<string>();

  async function visit(directory: string): Promise<void> {
    const realDirectory = await fs.realpath(directory).catch(() => directory);
    if (!isPathInsideOrEqual(rootRealPath, realDirectory)) {
      return;
    }
    if (visited.has(realDirectory)) {
      return;
    }
    visited.add(realDirectory);

    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.name === SKILL_FILE_NAME && entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files;
}

async function listHelperFiles(baseDir: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(
        path.relative(baseDir, absolutePath),
      );
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || relativePath === SKILL_FILE_NAME) {
        continue;
      }
      if (!isHiddenRelativePath(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  await visit(baseDir);
  return files;
}

function parseSkillFile(raw: string): ParsedSkillFile {
  const withoutBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const match =
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(
      withoutBom,
    );
  if (!match) {
    throw new Error("Missing YAML frontmatter");
  }
  const [, frontmatter = "", content = ""] = match;
  const parsed = parseYaml(frontmatter) as unknown;
  const result = SkillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    const error = new Error(message);
    error.name = "SkillInvalidError";
    throw error;
  }

  return {
    content,
    data: result.data,
  };
}

function toSkillInfo(input: {
  readonly filePath: string;
  readonly parsed: ParsedSkillFile;
  readonly scope: SkillScope;
}): SkillInfo {
  const baseDir = path.dirname(input.filePath);
  return {
    baseDir,
    description: input.parsed.data.description,
    disableModelInvocation: input.parsed.data["disable-model-invocation"],
    location: input.filePath,
    name: input.parsed.data.name,
    scope: input.scope,
    userInvocable: input.parsed.data["user-invocable"],
  };
}

export class SkillLoader implements SkillLoaderPort {
  private readonly directories: readonly SkillSearchDirectory[];
  private readonly logger: SkillLogger;

  constructor(options: SkillLoaderOptions = {}) {
    this.directories =
      options.directories ??
      getDefaultSkillDirectories({
        environment: options.environment,
        homeDirectory: options.homeDirectory,
        projectDirectory: options.projectDirectory,
      });
    this.logger = options.logger ?? defaultLogger();
  }

  async scan(): Promise<Map<string, SkillInfo>> {
    const skills = new Map<string, SkillInfo>();
    for (const directory of this.directories) {
      const skillFiles = await findSkillFiles(directory.path);
      for (const filePath of skillFiles) {
        let parsed: ParsedSkillFile;
        try {
          parsed = parseSkillFile(await fs.readFile(filePath, "utf8"));
        } catch (error) {
          this.logger.warn(`Invalid skill skipped: ${filePath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const info = toSkillInfo({
          filePath,
          parsed,
          scope: directory.scope,
        });
        const previous = skills.get(info.name);
        if (previous) {
          this.logger.warn(
            `Skill "${info.name}" from ${info.location} overrides ${previous.location}`,
            {
              nextScope: info.scope,
              previousScope: previous.scope,
            },
          );
        }
        skills.set(info.name, info);
      }
    }

    return skills;
  }

  async loadContent(info: SkillInfo): Promise<SkillContent> {
    try {
      const parsed = parseSkillFile(await fs.readFile(info.location, "utf8"));
      return {
        baseDir: info.baseDir,
        content: parsed.content,
        files: await listHelperFiles(info.baseDir),
        info,
      };
    } catch (error) {
      throw new SkillLoadError(info.location, error);
    }
  }
}
