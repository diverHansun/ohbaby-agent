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
  return (
    options.caseInsensitive ?? isSessionProjectRootCaseInsensitivePlatform()
  )
    ? normalized.toLowerCase()
    : normalized;
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
