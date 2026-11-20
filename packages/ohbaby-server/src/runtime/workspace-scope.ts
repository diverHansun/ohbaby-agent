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
  let isDirectory: boolean;
  try {
    canonicalDirectory = await realpath(requestedDirectory);
    isDirectory = (await stat(canonicalDirectory)).isDirectory();
    await access(
      canonicalDirectory,
      isDirectory ? constants.R_OK | constants.X_OK : constants.R_OK,
    );
  } catch (error) {
    throw new WorkspaceScopeError(
      "directory-unavailable",
      "The workspace folder is missing or unreadable.",
      { cause: error },
    );
  }

  if (!isDirectory) {
    throw new WorkspaceScopeError(
      "directory-not-directory",
      "The workspace path is not a folder.",
    );
  }

  const projectRoot = await Project.getProjectRoot(canonicalDirectory);
  return projectRoot === null ? canonicalDirectory : realpath(projectRoot);
}
