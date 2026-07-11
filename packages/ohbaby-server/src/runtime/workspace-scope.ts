import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Project } from "ohbaby-agent";

export type WorkspaceScopeErrorCode =
  | "directory-required"
  | "directory-must-be-absolute"
  | "directory-unavailable"
  | "directory-not-directory";

export class WorkspaceScopeError extends Error {
  constructor(
    readonly code: WorkspaceScopeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceScopeError";
  }
}

export async function resolveWorkspaceScope(
  directory: string,
): Promise<string> {
  const requestedDirectory = directory.trim();
  if (requestedDirectory.length === 0) {
    throw new WorkspaceScopeError(
      "directory-required",
      "x-ohbaby-directory is required",
    );
  }
  if (!isAbsolute(requestedDirectory)) {
    throw new WorkspaceScopeError(
      "directory-must-be-absolute",
      "x-ohbaby-directory must be an absolute path",
    );
  }

  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(requestedDirectory);
    await access(canonicalDirectory, constants.R_OK);
  } catch (error) {
    throw new WorkspaceScopeError(
      "directory-unavailable",
      "x-ohbaby-directory does not exist or is not readable",
      { cause: error },
    );
  }

  if (!(await stat(canonicalDirectory)).isDirectory()) {
    throw new WorkspaceScopeError(
      "directory-not-directory",
      "x-ohbaby-directory must identify a directory",
    );
  }

  const projectRoot = await Project.getProjectRoot(canonicalDirectory);
  return projectRoot === null ? canonicalDirectory : realpath(projectRoot);
}
