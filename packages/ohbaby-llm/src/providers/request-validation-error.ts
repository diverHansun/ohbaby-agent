/** Local request construction failed before the provider SDK was called. */
export class ModelRequestValidationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ModelRequestValidationError";
  }
}
