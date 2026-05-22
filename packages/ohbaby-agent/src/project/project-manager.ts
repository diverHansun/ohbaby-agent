import fs from "node:fs/promises";
import path from "node:path";
import { getGitProjectId } from "./project-identifier.js";
import { GLOBAL_PROJECT_ID, type ProjectInfo } from "./types.js";

function globalProject(rootPath: string): ProjectInfo {
  return {
    id: GLOBAL_PROJECT_ID,
    rootPath: path.resolve(rootPath),
  };
}

async function isExistingDirectory(directory: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directory);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function hasGitBoundary(directory: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(path.join(directory, ".git"));
    return stats.isDirectory() || stats.isFile() || stats.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function getProjectRoot(
  directory: string,
): Promise<string | null> {
  let current = path.resolve(directory);
  if (!(await isExistingDirectory(current))) {
    return null;
  }

  for (;;) {
    if (await hasGitBoundary(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function isGitProject(directory: string): Promise<boolean> {
  return (await getProjectRoot(directory)) !== null;
}

export async function fromDirectory(directory: string): Promise<ProjectInfo> {
  const resolvedDirectory = path.resolve(directory);
  if (!(await isExistingDirectory(resolvedDirectory))) {
    return globalProject(resolvedDirectory);
  }

  const rootPath = await getProjectRoot(resolvedDirectory);
  if (!rootPath) {
    return globalProject(resolvedDirectory);
  }

  const id = await getGitProjectId(rootPath);
  if (!id) {
    return globalProject(resolvedDirectory);
  }

  return {
    id,
    rootPath,
    vcs: "git",
  };
}
