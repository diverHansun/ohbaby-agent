/** Invalid process identities are unknown; never pass them to a liveness probe. */
export function isValidOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Only ESRCH proves death. Permission failures and unknown PIDs preserve work. */
export function isOwnerProcessAlive(pid: number): boolean {
  if (!isValidOwnerPid(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
