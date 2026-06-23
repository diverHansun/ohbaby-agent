import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Project } from "ohbaby-agent";

export interface DaemonScope {
  readonly pidFilePath: string;
  readonly scopeRoot: string;
  readonly stateFilePath: string;
}

export interface ResolveDaemonScopeOptions {
  readonly workdir?: string;
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function resolveDaemonScope(
  options: ResolveDaemonScopeOptions = {},
): Promise<DaemonScope> {
  const workdir = await canonicalDirectory(options.workdir ?? process.cwd());
  const projectRoot = await Project.getProjectRoot(workdir);
  const scopeRoot = projectRoot
    ? await canonicalDirectory(projectRoot)
    : workdir;
  const serverDir = join(scopeRoot, ".ohbaby", "server");

  return {
    pidFilePath: join(serverDir, "daemon.pid"),
    scopeRoot,
    stateFilePath: join(serverDir, "daemon-state.json"),
  };
}
