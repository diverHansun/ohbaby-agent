import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SkillLoadError, SkillResourceError } from "./errors.js";
import type {
  SkillContent,
  SkillInfo,
  SkillLoaderPort,
  SkillLogger,
  SkillResourceContent,
  SkillScope,
  SkillSearchDirectory,
  SkillSource,
} from "./types.js";

const GLOBAL_CONFIG_DIR_NAME = "ohbaby-agent";
const PROJECT_CONFIG_DIR_NAME = ".ohbaby-agent";
const SKILL_DIR_NAME = "skill";
const SKILLS_DIR_NAME = "skills";
const SKILL_FILE_NAME = "SKILL.md";

const SkillRequiredFrontmatterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1024),
  })
  .passthrough();

const PRIORITY = {
  plugin: 10,
  "codex-home": 20,
  "user-compatible": 30,
  "user-native": 40,
  "project-compatible": 50,
  "project-native": 60,
} as const;

type SkillFrontmatterData = z.infer<typeof SkillRequiredFrontmatterSchema> &
  Record<string, unknown>;

interface ParsedSkillFile {
  readonly data: SkillFrontmatterData;
  readonly content: string;
}

interface NormalizedSkillSearchDirectory extends SkillSearchDirectory {
  readonly source: SkillSource;
  readonly priority: number;
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

function getGlobalSkillsDirectory(
  homeDirectory = os.homedir(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.join(
    getGlobalConfigRoot(homeDirectory, environment),
    GLOBAL_CONFIG_DIR_NAME,
    SKILLS_DIR_NAME,
  );
}

export function getProjectSkillDirectory(
  projectDirectory = process.cwd(),
): string {
  return path.join(projectDirectory, PROJECT_CONFIG_DIR_NAME, SKILL_DIR_NAME);
}

function getProjectSkillsDirectory(projectDirectory = process.cwd()): string {
  return path.join(projectDirectory, PROJECT_CONFIG_DIR_NAME, SKILLS_DIR_NAME);
}

function getCodexHomeSkillsDirectory(
  homeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(
    environment.CODEX_HOME ?? path.join(homeDirectory, ".codex"),
    SKILLS_DIR_NAME,
  );
}

export function getDefaultSkillDirectories(
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly projectDirectory?: string;
  } = {},
): readonly SkillSearchDirectory[] {
  const homeDirectory = input.homeDirectory ?? os.homedir();
  const environment = input.environment ?? process.env;
  const projectDirectory = input.projectDirectory ?? process.cwd();

  return [
    {
      path: getCodexHomeSkillsDirectory(homeDirectory, environment),
      priority: PRIORITY["codex-home"],
      scope: "user",
      source: "codex-home",
    },
    {
      path: path.join(homeDirectory, ".claude", SKILLS_DIR_NAME),
      priority: PRIORITY["user-compatible"],
      scope: "user",
      source: "claude-compatible",
    },
    {
      path: path.join(homeDirectory, ".agents", SKILLS_DIR_NAME),
      priority: PRIORITY["user-compatible"],
      scope: "user",
      source: "agents-compatible",
    },
    {
      path: getGlobalSkillsDirectory(homeDirectory, environment),
      priority: PRIORITY["user-native"],
      scope: "user",
      source: "user-native",
    },
    {
      path: getGlobalSkillDirectory(homeDirectory, environment),
      priority: PRIORITY["user-native"],
      scope: "user",
      source: "user-native",
    },
    {
      path: path.join(projectDirectory, ".claude", SKILLS_DIR_NAME),
      priority: PRIORITY["project-compatible"],
      scope: "project",
      source: "claude-compatible",
    },
    {
      path: path.join(projectDirectory, ".agents", SKILLS_DIR_NAME),
      priority: PRIORITY["project-compatible"],
      scope: "project",
      source: "agents-compatible",
    },
    {
      path: getProjectSkillsDirectory(projectDirectory),
      priority: PRIORITY["project-native"],
      scope: "project",
      source: "project-native",
    },
    {
      path: getProjectSkillDirectory(projectDirectory),
      priority: PRIORITY["project-native"],
      scope: "project",
      source: "project-native",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isHiddenRelativePath(value: string): boolean {
  return normalizeRelativePath(value)
    .split("/")
    .some((segment) => segment.startsWith("."));
}

function defaultPriorityFor(source: SkillSource, scope: SkillScope): number {
  if (source === "plugin") {
    return PRIORITY.plugin;
  }
  if (source === "codex-home") {
    return PRIORITY["codex-home"];
  }
  if (source === "project-native") {
    return PRIORITY["project-native"];
  }
  if (source === "user-native") {
    return PRIORITY["user-native"];
  }
  return scope === "project"
    ? PRIORITY["project-compatible"]
    : PRIORITY["user-compatible"];
}

function defaultSourceFor(scope: SkillScope): SkillSource {
  return scope === "project" ? "project-native" : "user-native";
}

function normalizeDirectory(
  directory: SkillSearchDirectory,
): NormalizedSkillSearchDirectory {
  const source = directory.source ?? defaultSourceFor(directory.scope);
  return {
    ...directory,
    path: path.resolve(directory.path),
    priority: directory.priority ?? defaultPriorityFor(source, directory.scope),
    source,
  };
}

function normalizePluginDirectory(
  pluginId: string,
  directory: string | SkillSearchDirectory,
): NormalizedSkillSearchDirectory {
  const descriptor =
    typeof directory === "string"
      ? {
          path: directory,
          scope: "project" as const,
        }
      : directory;
  return normalizeDirectory({
    ...descriptor,
    pluginId,
    priority: descriptor.priority ?? PRIORITY.plugin,
    source: "plugin",
  });
}

function sortDirectories(
  directories: readonly NormalizedSkillSearchDirectory[],
): readonly NormalizedSkillSearchDirectory[] {
  return [...directories].sort((left, right) => {
    const byPriority = left.priority - right.priority;
    if (byPriority !== 0) {
      return byPriority;
    }
    return left.path.localeCompare(right.path);
  });
}

async function readUtf8File(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
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
  const result = SkillRequiredFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    const error = new Error(message);
    error.name = "SkillInvalidError";
    throw error;
  }
  if (content.trim() === "") {
    throw new Error("Skill body is required");
  }

  return {
    content,
    data: result.data,
  };
}

function warnInvalidOptionalField(input: {
  readonly field: string;
  readonly filePath: string;
  readonly logger: SkillLogger;
  readonly message: string;
}): void {
  input.logger.warn("Invalid optional skill field", {
    error: input.message,
    field: input.field,
    filePath: input.filePath,
  });
}

function optionalBoolean(input: {
  readonly data: SkillFrontmatterData;
  readonly defaultValue: boolean;
  readonly field: string;
  readonly filePath: string;
  readonly logger: SkillLogger;
}): boolean {
  const value = input.data[input.field];
  if (value === undefined) {
    return input.defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  warnInvalidOptionalField({
    field: input.field,
    filePath: input.filePath,
    logger: input.logger,
    message: "Expected boolean.",
  });
  return input.defaultValue;
}

function optionalString(input: {
  readonly data: SkillFrontmatterData;
  readonly field: string;
  readonly filePath: string;
  readonly logger: SkillLogger;
}): string | undefined {
  const value = input.data[input.field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  warnInvalidOptionalField({
    field: input.field,
    filePath: input.filePath,
    logger: input.logger,
    message: "Expected string.",
  });
  return undefined;
}

function optionalAllowedTools(input: {
  readonly data: SkillFrontmatterData;
  readonly filePath: string;
  readonly logger: SkillLogger;
}): readonly string[] {
  const value = input.data["allowed-tools"];
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() === "" ? [] : [value.trim()];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter((item) => item.length > 0);
  }
  warnInvalidOptionalField({
    field: "allowed-tools",
    filePath: input.filePath,
    logger: input.logger,
    message: "Expected string or string array.",
  });
  return [];
}

function optionalMetadata(input: {
  readonly data: SkillFrontmatterData;
  readonly filePath: string;
  readonly logger: SkillLogger;
}): Readonly<Record<string, unknown>> {
  const value = input.data.metadata;
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return { ...value };
  }
  warnInvalidOptionalField({
    field: "metadata",
    filePath: input.filePath,
    logger: input.logger,
    message: "Expected object.",
  });
  return {};
}

function toSkillInfo(input: {
  readonly directory: NormalizedSkillSearchDirectory;
  readonly filePath: string;
  readonly logger: SkillLogger;
  readonly parsed: ParsedSkillFile;
}): SkillInfo {
  const baseDir = path.dirname(input.filePath);
  const license = optionalString({
    data: input.parsed.data,
    field: "license",
    filePath: input.filePath,
    logger: input.logger,
  });
  return {
    allowedTools: optionalAllowedTools({
      data: input.parsed.data,
      filePath: input.filePath,
      logger: input.logger,
    }),
    baseDir,
    description: input.parsed.data.description,
    disableModelInvocation: optionalBoolean({
      data: input.parsed.data,
      defaultValue: false,
      field: "disable-model-invocation",
      filePath: input.filePath,
      logger: input.logger,
    }),
    frontmatter: { ...input.parsed.data },
    ...(license === undefined ? {} : { license }),
    location: input.filePath,
    metadata: optionalMetadata({
      data: input.parsed.data,
      filePath: input.filePath,
      logger: input.logger,
    }),
    name: input.parsed.data.name,
    ...(input.directory.pluginId === undefined
      ? {}
      : { pluginId: input.directory.pluginId }),
    scope: input.directory.scope,
    source: input.directory.source,
    userInvocable: optionalBoolean({
      data: input.parsed.data,
      defaultValue: true,
      field: "user-invocable",
      filePath: input.filePath,
      logger: input.logger,
    }),
  };
}

function safeResourcePath(resourcePath: string): string {
  const trimmed = resourcePath.trim();
  if (trimmed === "") {
    throw new SkillResourceError(resourcePath, "path is required");
  }
  if (path.isAbsolute(trimmed)) {
    throw new SkillResourceError(
      resourcePath,
      "absolute paths are not allowed",
    );
  }

  const normalized = normalizeRelativePath(path.normalize(trimmed));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new SkillResourceError(resourcePath, "path escapes skill directory");
  }
  if (normalized === SKILL_FILE_NAME) {
    throw new SkillResourceError(resourcePath, "SKILL.md is not a resource");
  }
  if (isHiddenRelativePath(normalized)) {
    throw new SkillResourceError(resourcePath, "hidden paths are not allowed");
  }
  return normalized;
}

export class SkillLoader implements SkillLoaderPort {
  private readonly directories: readonly NormalizedSkillSearchDirectory[];
  private readonly logger: SkillLogger;
  private readonly pluginDirectories = new Map<
    string,
    readonly NormalizedSkillSearchDirectory[]
  >();

  constructor(options: SkillLoaderOptions = {}) {
    this.directories = (
      options.directories ??
      getDefaultSkillDirectories({
        environment: options.environment,
        homeDirectory: options.homeDirectory,
        projectDirectory: options.projectDirectory,
      })
    ).map(normalizeDirectory);
    this.logger = options.logger ?? defaultLogger();
  }

  registerPluginSkills(
    pluginId: string,
    directories: readonly (string | SkillSearchDirectory)[],
  ): void {
    if (pluginId.trim() === "") {
      throw new Error("Plugin id is required to register skill directories.");
    }
    this.pluginDirectories.set(
      pluginId,
      directories.map((directory) =>
        normalizePluginDirectory(pluginId, directory),
      ),
    );
  }

  deregisterPlugin(pluginId: string): void {
    this.pluginDirectories.delete(pluginId);
  }

  private allDirectories(): readonly NormalizedSkillSearchDirectory[] {
    return sortDirectories([
      ...this.directories,
      ...Array.from(this.pluginDirectories.values()).flat(),
    ]);
  }

  async scan(): Promise<Map<string, SkillInfo>> {
    const skills = new Map<string, SkillInfo>();
    const priorities = new Map<string, number>();
    for (const directory of this.allDirectories()) {
      const skillFiles = await findSkillFiles(directory.path);
      for (const filePath of skillFiles) {
        let parsed: ParsedSkillFile;
        try {
          parsed = parseSkillFile(await readUtf8File(filePath));
        } catch (error) {
          this.logger.warn(`Invalid skill skipped: ${filePath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const info = toSkillInfo({
          directory,
          filePath,
          logger: this.logger,
          parsed,
        });
        const previous = skills.get(info.name);
        const previousPriority = priorities.get(info.name);
        if (previous && previousPriority !== undefined) {
          if (directory.priority < previousPriority) {
            this.logger.warn(
              `Skill "${info.name}" from ${info.location} ignored because ${previous.location} has higher precedence`,
              {
                nextScope: info.scope,
                nextSource: info.source,
                previousScope: previous.scope,
                previousSource: previous.source,
              },
            );
            continue;
          }
          this.logger.warn(
            `Skill "${info.name}" from ${info.location} overrides ${previous.location}`,
            {
              nextScope: info.scope,
              nextSource: info.source,
              previousScope: previous.scope,
              previousSource: previous.source,
            },
          );
        }
        priorities.set(info.name, directory.priority);
        skills.set(info.name, info);
      }
    }

    return skills;
  }

  async loadContent(info: SkillInfo): Promise<SkillContent> {
    try {
      const parsed = parseSkillFile(await readUtf8File(info.location));
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

  async readResource(
    info: SkillInfo,
    resourcePath: string,
  ): Promise<SkillResourceContent> {
    const relativePath = safeResourcePath(resourcePath);
    try {
      const baseRealPath = await fs.realpath(info.baseDir);
      const absolutePath = path.join(info.baseDir, relativePath);
      const linkStats = await fs.lstat(absolutePath);
      if (linkStats.isSymbolicLink()) {
        throw new SkillResourceError(resourcePath, "symlinks are not allowed");
      }
      const realPath = await fs.realpath(absolutePath);
      if (!isPathInsideOrEqual(baseRealPath, realPath)) {
        throw new SkillResourceError(
          resourcePath,
          "path escapes skill directory",
        );
      }
      const stats = await fs.stat(realPath);
      if (!stats.isFile()) {
        throw new SkillResourceError(resourcePath, "resource is not a file");
      }
      const handle = await fs.open(
        realPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const handleStats = await handle.stat();
        if (!handleStats.isFile()) {
          throw new SkillResourceError(resourcePath, "resource is not a file");
        }
        const bytes = await handle.readFile();
        return {
          baseDir: info.baseDir,
          content: decodeUtf8(bytes),
          info,
          path: relativePath,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof SkillResourceError) {
        throw error;
      }
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new SkillResourceError(resourcePath, "resource not found", error);
      }
      if (isNodeErrorCode(error, "ELOOP")) {
        throw new SkillResourceError(
          resourcePath,
          "symlinks are not allowed",
          error,
        );
      }
      throw new SkillResourceError(
        resourcePath,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}
