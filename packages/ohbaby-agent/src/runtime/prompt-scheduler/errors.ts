export class PromptQueueFullError extends Error {
  readonly code = "QUEUE_FULL";
  readonly source = "scheduler";

  constructor(
    readonly scopeKey: string,
    readonly limit: number,
  ) {
    super(`Prompt queue is full for ${scopeKey} (limit ${String(limit)})`);
    this.name = "PromptQueueFullError";
  }
}

export class PromptSubmissionNotFoundError extends Error {
  readonly code = "PROMPT_NOT_FOUND";

  constructor(readonly promptId: string) {
    super(`Prompt submission not found: ${promptId}`);
    this.name = "PromptSubmissionNotFoundError";
  }
}

export class PromptNotQueuedError extends Error {
  readonly code = "PROMPT_NOT_QUEUED";

  constructor(readonly promptId: string) {
    super(`Prompt submission is no longer queued: ${promptId}`);
    this.name = "PromptNotQueuedError";
  }
}

export class PromptVersionConflictError extends Error {
  readonly code = "PROMPT_VERSION_CONFLICT";

  constructor(readonly promptId: string) {
    super(`Prompt submission changed before this operation: ${promptId}`);
    this.name = "PromptVersionConflictError";
  }
}

export class PromptIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly clientRequestId: string) {
    super(
      `Prompt request id was reused with different input: ${clientRequestId}`,
    );
    this.name = "PromptIdempotencyConflictError";
  }
}

export class InvalidPromptClientRequestIdError extends Error {
  readonly code = "INVALID_CLIENT_REQUEST_ID";

  constructor(readonly clientRequestId: string) {
    super(
      "Prompt clientRequestId must be non-empty and must not use the reserved legacy: prefix",
    );
    this.name = "InvalidPromptClientRequestIdError";
  }
}

export class PromptEditLeaseHeldError extends Error {
  readonly code = "PROMPT_EDIT_LEASE_HELD";

  constructor(readonly promptId: string) {
    super(`Prompt submission is already being edited: ${promptId}`);
    this.name = "PromptEditLeaseHeldError";
  }
}

export class PromptEditLeaseLostError extends Error {
  readonly code = "PROMPT_EDIT_LEASE_LOST";

  constructor(readonly promptId: string) {
    super(`Prompt edit lease is no longer valid: ${promptId}`);
    this.name = "PromptEditLeaseLostError";
  }
}

export class InvalidPromptTransitionError extends Error {
  readonly code = "INVALID_PROMPT_TRANSITION";

  constructor(
    readonly promptId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid prompt transition for ${promptId}: ${from} -> ${to}`);
    this.name = "InvalidPromptTransitionError";
  }
}

export class PromptSchedulerClosedError extends Error {
  readonly code = "PROMPT_SCHEDULER_CLOSED";

  constructor() {
    super("Prompt scheduler is closed");
    this.name = "PromptSchedulerClosedError";
  }
}
