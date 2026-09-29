/** Invalid process identities are unknown; never pass them to a liveness probe. */
export function isValidOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
