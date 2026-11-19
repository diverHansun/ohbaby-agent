/** The connection closed before the protocol's terminal event. */
export class ProviderStreamEofError extends Error {
  constructor(message = "Provider stream ended without a terminal event") {
    super(message);
    this.name = "ProviderStreamEofError";
  }
}

/** An explicit failure event, including when the upstream omits its error body. */
export class ProviderStreamFailureError extends Error {
  constructor(
    event: string,
    readonly error: unknown,
  ) {
    super(`Responses ${event}: provider failure`);
    this.name = "ProviderStreamFailureError";
  }
}
