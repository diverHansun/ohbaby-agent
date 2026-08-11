import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveLegacyGlobalMemoryPath,
  resolveLegacyOhbabyHome,
  resolveReadPathWithLegacy,
} from "../../paths/index.js";
import { MEMORY_FILENAME } from "./constants.js";
import {
  findProjectMemoryPath,
  getGlobalMemoryPath,
} from "./memory-discovery.js";
import type {
  MemoryLoader,
  MemoryLoaderOptions,
  MergedMemory,
  ProjectInfo,
  ProjectResolver,
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

export function createMemoryLoader(
  options: Partial<MemoryLoaderOptions> = {},
): MemoryLoader {
  const projectResolver = options.projectResolver ?? FALLBACK_PROJECT_RESOLVER;
  const globalMemoryPath = options.globalMemoryPath ?? getGlobalMemoryPath();
  const legacyGlobalMemoryPaths =
    options.globalMemoryPath === undefined
      ? [
          path.join(resolveLegacyOhbabyHome(), MEMORY_FILENAME),
          resolveLegacyGlobalMemoryPath(),
        ]
      : [];

  async function resolveGlobalReadPath(): Promise<string> {
    return resolveReadPathWithLegacy(globalMemoryPath, legacyGlobalMemoryPaths);
  }

  async function getProjectInfo(directory: string): Promise<ProjectInfo> {
    return projectResolver.fromDirectory(directory);
  }

  return {
    async load(directory: string): Promise<MergedMemory> {
      const project = await getProjectInfo(directory);
      const projectMemoryPath = await findProjectMemoryPath(
        directory,
        project.rootPath,
      );
      const globalReadPath = await resolveGlobalReadPath();
      const [globalContent, projectContent] = await Promise.all([
        readUtf8File(globalReadPath, options.onWarning),
        readUtf8File(projectMemoryPath, options.onWarning),
      ]);

      return {
        global: globalContent,
        project: projectContent,
        merged: mergeMemory({
          globalContent,
          globalPath: globalReadPath,
          projectContent,
          projectPath: projectMemoryPath,
        }),
      };
    },
  };
}
