import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Project, resolveOhbabyHome } from "ohbaby-agent";

export interface DaemonScope {
  readonly legacyPidFilePath: string;
  readonly legacyStateFilePath: string;
  readonly pidFilePath: string;
  readonly scopeRoot: string;
  readonly stateFilePath: string;
}

export interface ResolveDaemonScopeOptions {
  readonly homeDirectory?: string;
  readonly workdir?: string;
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function canonicalPath(inputPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = resolve(inputPath);
  for (;;) {
    try {
      return join(await realpath(candidate), ...missingSegments.reverse());
    } catch {
      const parent = resolve(candidate, "..");
      if (parent === candidate) {
        return resolve(inputPath);
      }
      missingSegments.push(candidate.slice(parent.length + 1));
      candidate = parent;
    }
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
  const configHome = await canonicalPath(
    resolveOhbabyHome({ homeDirectory: options.homeDirectory }),
  );
  const serverDir = join(configHome, "server");
  const legacyServerDir = join(scopeRoot, ".ohbaby", "server");

  return {
    legacyPidFilePath: join(legacyServerDir, "daemon.pid"),
    legacyStateFilePath: join(legacyServerDir, "daemon-state.json"),
    pidFilePath: join(serverDir, "daemon.pid"),
    scopeRoot,
    stateFilePath: join(serverDir, "daemon-state.json"),
  };
}
