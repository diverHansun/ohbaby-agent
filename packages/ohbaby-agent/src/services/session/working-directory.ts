export interface SessionDirectoryCompareOptions {
  readonly caseInsensitive?: boolean;
}

export function isSessionDirectoryCaseInsensitivePlatform(
  platform = process.platform,
): boolean {
  return platform === "win32";
}

export function normalizeSessionDirectory(
  root: string | undefined,
  options: SessionDirectoryCompareOptions = {},
): string {
  const normalized = (root ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  return (options.caseInsensitive ??
    isSessionDirectoryCaseInsensitivePlatform())
    ? normalized.toLowerCase()
    : normalized;
}

interface SessionRootFields {
  readonly workingDirectory: string;
  readonly pendingWorkingDirectory?: string;
}

/** The directory whose workspace must run the session's next turn. */
export function sessionTargetWorkingDirectory(
  session: SessionRootFields,
): string {
  return session.pendingWorkingDirectory ?? session.workingDirectory;
}

/**
 * Moving to a workspace changes the next turn's directory unless the session
 * already runs there. Leaving a workspace keeps the current directory and
 * cancels a change that has not started yet.
 */
export function resolveSessionWorkspaceBinding(
  session: SessionRootFields,
  workspaceDirectory: string | null,
): {
  readonly workspaceDirectory?: string;
  readonly pendingWorkingDirectory?: string;
} {
  if (workspaceDirectory === null) return {};
  return sameSessionDirectory(session.workingDirectory, workspaceDirectory)
    ? { workspaceDirectory }
    : { workspaceDirectory, pendingWorkingDirectory: workspaceDirectory };
}

/** Applies a starting turn's directory without dropping a newer pending target. */
export function withSessionWorkingDirectory<T extends SessionRootFields>(
  session: T,
  input: { readonly projectId: string; readonly workingDirectory: string },
): T & { readonly projectId: string } {
  const pendingApplied = sameSessionDirectory(
    session.pendingWorkingDirectory,
    input.workingDirectory,
  );
  return {
    ...session,
    projectId: input.projectId,
    workingDirectory: input.workingDirectory,
    pendingWorkingDirectory: pendingApplied
      ? undefined
      : session.pendingWorkingDirectory,
  };
}

/** Both the current and the pending execution directory may observe a moved session. */
export function isSessionInWorkingDirectory(
  session: SessionRootFields,
  workingDirectory: string,
): boolean {
  return (
    sameSessionDirectory(session.workingDirectory, workingDirectory) ||
    sameSessionDirectory(session.pendingWorkingDirectory, workingDirectory)
  );
}

export function sameSessionDirectory(
  left: string | undefined,
  right: string | undefined,
  options: SessionDirectoryCompareOptions = {},
): boolean {
  const normalizedLeft = normalizeSessionDirectory(left, options);
  return (
    normalizedLeft !== "" &&
    normalizedLeft === normalizeSessionDirectory(right, options)
  );
}
