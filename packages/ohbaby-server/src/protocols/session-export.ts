import type { UiExportSessionInput } from "ohbaby-sdk";

export function parseSessionExportInput(value: unknown): UiExportSessionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("Session export input must be an object"), {
      code: "INVALID_ARGUMENT",
    });
  }
  const input = value as Record<string, unknown>;
  if (input.format !== "html" && input.format !== "jsonl") {
    throw Object.assign(new Error("format must be html or jsonl"), {
      code: "INVALID_FORMAT",
    });
  }
  if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
    throw Object.assign(new Error("sessionId is required"), {
      code: "INVALID_ARGUMENT",
    });
  }
  return { sessionId: input.sessionId, format: input.format };
}

export function sessionExportErrorStatus(
  error: unknown,
): 400 | 404 | 409 | 500 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  switch (code) {
    case "INVALID_FORMAT":
    case "INVALID_ARGUMENT":
    case "EMPTY_SESSION":
    case "SUBAGENT_SESSION":
      return 400;
    case "SESSION_NOT_FOUND":
      return 404;
    case "CLIENT_NOT_REGISTERED":
      return 409;
    default:
      return 500;
  }
}
