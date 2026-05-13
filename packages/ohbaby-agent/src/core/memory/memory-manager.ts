import fs from "node:fs/promises";
import path from "node:path";
import { createBus } from "../../bus/index.js";
import { MEMORY_FILENAME } from "./constants.js";
import { MemoryEvent } from "./events.js";
import {
  findProjectMemoryPath,
  getGlobalMemoryPath,
} from "./memory-discovery.js";
import {
  computeAddedMemoryContent,
  formatTimestamp,
  parseMemoryEntries,
  removeMemoryEntry,
  updateMemoryEntry,
} from "./memory-parser.js";
import type {
  AddMemoryInput,
  MemoryEntry,
  MemoryManager,
  MemoryManagerOptions,
  MemoryScope,
  MergedMemory,
  ProjectInfo,
  ProjectResolver,
  RemoveMemoryInput,
  UpdateMemoryInput,
} from "./types.js";

const FALLBACK_PROJECT_RESOLVER: ProjectResolver = {
  fromDirectory(directory: string): ProjectInfo {
    return {
      id: "global",
      rootPath: directory,
    };
  },
};

async function readUtf8File(
  filePath: string | null,
  onWarning?: (message: string, error?: unknown) => void,
): Promise<string> {
  if (!filePath) {
    return "";
  }

  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    if (code !== "ENOENT") {
      onWarning?.(`Unable to read memory file: ${filePath}`, error);
    }
    return "";
  }
}

function mergeMemory(input: {
  readonly globalContent: string;
  readonly globalPath: string;
  readonly projectContent: string;
  readonly projectPath: string | null;
}): string {
  const parts: string[] = [];
  const global = input.globalContent.trim();
  const project = input.projectContent.trim();

  if (global) {
    parts.push(`<!-- Global Memory from ${input.globalPath} -->\n${global}`);
  }
  if (project) {
    parts.push(
      `<!-- Project Memory from ${input.projectPath ?? "<project-root>/OHBABY.md"} -->\n${project}`,
    );
  }

  return parts.join("\n\n---\n\n");
}

async function writeUtf8File(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function requireProjectDirectory(
  scope: MemoryScope,
  directory: string | undefined,
): string {
  if (scope === "project" && !directory) {
    throw new Error("Project memory requires a directory");
  }
  return directory ?? process.cwd();
}

export function createMemoryManager(
  options: Partial<MemoryManagerOptions> = {},
): MemoryManager {
  const bus = options.bus ?? createBus();
  const projectResolver = options.projectResolver ?? FALLBACK_PROJECT_RESOLVER;
  const globalMemoryPath = options.globalMemoryPath ?? getGlobalMemoryPath();
  const now = options.now ?? ((): Date => new Date());

  async function getProjectInfo(directory: string): Promise<ProjectInfo> {
    return projectResolver.fromDirectory(directory);
  }

  async function resolveProjectReadPath(
    directory: string,
  ): Promise<string | null> {
    const project = await getProjectInfo(directory);
    return findProjectMemoryPath(directory, project.rootPath);
  }

  async function resolveWritePath(
    scope: MemoryScope,
    directory: string | undefined,
  ): Promise<string> {
    if (scope === "global") {
      return globalMemoryPath;
    }

    const projectDirectory = requireProjectDirectory(scope, directory);
    const project = await getProjectInfo(projectDirectory);
    const existingPath = await findProjectMemoryPath(
      projectDirectory,
      project.rootPath,
    );

    return existingPath ?? path.join(project.rootPath, MEMORY_FILENAME);
  }

  async function readScopeContent(
    scope: MemoryScope,
    directory: string | undefined,
  ): Promise<string> {
    if (scope === "global") {
      return readUtf8File(globalMemoryPath, options.onWarning);
    }

    const projectDirectory = requireProjectDirectory(scope, directory);
    return readUtf8File(
      await resolveProjectReadPath(projectDirectory),
      options.onWarning,
    );
  }

  return {
    async load(directory: string): Promise<MergedMemory> {
      const project = await getProjectInfo(directory);
      const projectMemoryPath = await findProjectMemoryPath(
        directory,
        project.rootPath,
      );
      const [globalContent, projectContent] = await Promise.all([
        readUtf8File(globalMemoryPath, options.onWarning),
        readUtf8File(projectMemoryPath, options.onWarning),
      ]);

      return {
        global: globalContent,
        project: projectContent,
        merged: mergeMemory({
          globalContent,
          globalPath: globalMemoryPath,
          projectContent,
          projectPath: projectMemoryPath,
        }),
      };
    },

    async add(input: AddMemoryInput): Promise<void> {
      const filePath = await resolveWritePath(input.scope, input.directory);
      const currentContent = await readUtf8File(filePath, options.onWarning);
      await writeUtf8File(
        filePath,
        computeAddedMemoryContent(
          currentContent,
          input.fact,
          formatTimestamp(now()),
        ),
      );
      bus.publish(MemoryEvent.Added, {
        scope: input.scope,
        text: input.fact,
      });
    },

    async update(input: UpdateMemoryInput): Promise<void> {
      const filePath = await resolveWritePath(input.scope, input.directory);
      const currentContent = await readUtf8File(filePath, options.onWarning);
      await writeUtf8File(
        filePath,
        updateMemoryEntry(currentContent, input.index, input.newText),
      );
      bus.publish(MemoryEvent.Updated, {
        scope: input.scope,
        index: input.index,
        newText: input.newText,
      });
    },

    async remove(input: RemoveMemoryInput): Promise<void> {
      const filePath = await resolveWritePath(input.scope, input.directory);
      const currentContent = await readUtf8File(filePath, options.onWarning);
      await writeUtf8File(
        filePath,
        removeMemoryEntry(currentContent, input.index),
      );
      bus.publish(MemoryEvent.Removed, {
        scope: input.scope,
        index: input.index,
      });
    },

    async listEntries(
      scope: MemoryScope,
      directory?: string,
    ): Promise<MemoryEntry[]> {
      return parseMemoryEntries(await readScopeContent(scope, directory));
    },

    async refresh(directory: string): Promise<MergedMemory> {
      const memory = await this.load(directory);
      bus.publish(MemoryEvent.Refreshed, { directory, memory });
      return memory;
    },
  };
}
