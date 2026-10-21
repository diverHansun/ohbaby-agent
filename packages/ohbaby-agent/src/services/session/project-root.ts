export interface SessionProjectRootCompareOptions {
  readonly caseInsensitive?: boolean;
}

export function isSessionProjectRootCaseInsensitivePlatform(
  platform = process.platform,
): boolean {
  return platform === "win32";
}

export function normalizeSessionProjectRoot(
  root: string | undefined,
  options: SessionProjectRootCompareOptions = {},
): string {
  const normalized = (root ?? "").replace(/\\/gu, "/").replace(/\/+$/u, "");
  return (options.caseInsensitive ??
    isSessionProjectRootCaseInsensitivePlatform())
    ? normalized.toLowerCase()
    : normalized;
}

interface SessionRootFields {
  readonly projectRoot: string;
  readonly pendingProjectRoot?: string;
}

/** The directory whose workspace must run the session's next turn. */
export function sessionTargetProjectRoot(session: SessionRootFields): string {
  return session.pendingProjectRoot ?? session.projectRoot;
}

/**
 * Moving to a project changes the next turn's directory unless the session
 * already runs there. Leaving a project keeps the current directory and
 * cancels a change that has not started yet.
 */
export function resolveSessionProjectBinding(
  session: SessionRootFields,
  projectDirectory: string | null,
): {
  readonly projectDirectory?: string;
  readonly pendingProjectRoot?: string;
} {
  if (projectDirectory === null) return {};
  return sameSessionProjectRoot(session.projectRoot, projectDirectory)
    ? { projectDirectory }
    : { projectDirectory, pendingProjectRoot: projectDirectory };
}

/** Applies a starting turn's directory without dropping a newer pending target. */
export function withSessionExecutionRoot<T extends SessionRootFields>(
  session: T,
  input: { readonly projectId: string; readonly projectRoot: string },
): T & { readonly projectId: string } {
  const pendingApplied = sameSessionProjectRoot(
    session.pendingProjectRoot,
    input.projectRoot,
  );
  return {
    ...session,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    pendingProjectRoot: pendingApplied ? undefined : session.pendingProjectRoot,
  };
}

/** Both the current and the pending execution directory may observe a moved session. */
export function isSessionInProjectRoot(
  session: SessionRootFields,
  projectRoot: string,
): boolean {
  return (
    sameSessionProjectRoot(session.projectRoot, projectRoot) ||
    sameSessionProjectRoot(session.pendingProjectRoot, projectRoot)
  );
}

export function sameSessionProjectRoot(
  left: string | undefined,
  right: string | undefined,
  options: SessionProjectRootCompareOptions = {},
): boolean {
  const normalizedLeft = normalizeSessionProjectRoot(left, options);
  return (
    normalizedLeft !== "" &&
    normalizedLeft === normalizeSessionProjectRoot(right, options)
  );
}
