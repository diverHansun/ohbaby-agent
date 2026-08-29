const STABLE_ERROR_CODE_PATTERN = /^[A-Z0-9_:-]{1,64}$/;

export function isStableErrorCode(value: unknown): value is string {
  return typeof value === "string" && STABLE_ERROR_CODE_PATTERN.test(value);
}
