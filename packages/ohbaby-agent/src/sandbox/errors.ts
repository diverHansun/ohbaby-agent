import { IrisError } from "../utils/index.js";

export class SandboxContextNotFoundError extends IrisError {
  constructor(sessionId: string) {
    super(
      "SANDBOX_CONTEXT_NOT_FOUND",
      `Sandbox context not found for session: ${sessionId}`,
      { sessionId },
    );
  }
}

export class SandboxContextAlreadyExistsError extends IrisError {
  constructor(sessionId: string) {
    super(
      "SANDBOX_CONTEXT_ALREADY_EXISTS",
      `Sandbox context already exists for session: ${sessionId}`,
      { sessionId },
    );
  }
}

export class SandboxBoundaryError extends IrisError {
  constructor(
    inputPath: string,
    workdir: string,
    resolvedPath: string,
  ) {
    super(
      "SANDBOX_BOUNDARY_ERROR",
      `Path escapes sandbox boundary: ${inputPath}`,
      { inputPath, resolvedPath, workdir },
    );
  }
}

export class SandboxAdapterError extends IrisError {
  constructor(message: string, data?: Record<string, unknown>) {
    super("SANDBOX_ADAPTER_ERROR", message, data);
  }
}
