/**
 * The model produced tool call arguments that are not valid JSON.
 *
 * This is a model output defect, not a transport failure: retrying the same
 * request or resuming the stream cannot fix it, so it must not be classified
 * as a provider interruption.
 */
export class ToolCallParseError extends Error {
  constructor(
    readonly toolName: string,
    override readonly cause: unknown,
  ) {
    super(
      `Model produced malformed tool call arguments for "${toolName}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ToolCallParseError";
  }
}

function errorStringField(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function isContextOverflowError(error: unknown): boolean {
  const candidates = [
    errorStringField(error, "code"),
    errorStringField(error, "type"),
    errorStringField(error, "message"),
    error instanceof Error ? error.message : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());

  return candidates.some(
    (value) =>
      value.includes("context_length_exceeded") ||
      value.includes("context length") ||
      value.includes("context window") ||
      value.includes("maximum context") ||
      value.includes("too many tokens") ||
      value.includes("token limit"),
  );
}
