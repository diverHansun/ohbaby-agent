import { defineDiagnosticEvent, diagnosticField } from "./logger.js";

const unusedSummaryReasons = [
  "aborted",
  "failed",
  "inflated",
  "stale",
  "summary-body-limit",
] as const;
export type UnusedSummaryReason = (typeof unusedSummaryReasons)[number];

export const contextSummaryUnused = defineDiagnosticEvent({
  component: "llm",
  event: "llm.context_summary.unused",
  fields: {
    // Stable diagnostic fingerprints of the request and compaction identities.
    operationId: diagnosticField.externalId("operation"),
    compactionId: diagnosticField.externalId("operation"),
    attempt: diagnosticField.integer(),
    reason: diagnosticField.stringEnum(unusedSummaryReasons),
    inputTokens: diagnosticField.optional(diagnosticField.integer()),
    outputTokens: diagnosticField.optional(diagnosticField.integer()),
    totalTokens: diagnosticField.optional(diagnosticField.integer()),
    reasoningTokens: diagnosticField.optional(diagnosticField.integer()),
    cacheReadTokens: diagnosticField.optional(diagnosticField.integer()),
    cacheWriteTokens: diagnosticField.optional(diagnosticField.integer()),
  },
  level: "warn",
});

export const diagnosticsStarted = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.started",
  fields: {
    role: diagnosticField.stringEnum(["tui", "serve", "cli"]),
  },
  level: "info",
});

export const loggerEventsDropped = defineDiagnosticEvent({
  component: "diagnostics",
  event: "logger.events_dropped",
  fields: {
    debug: diagnosticField.integer(),
    error: diagnosticField.integer(),
    info: diagnosticField.integer(),
    trace: diagnosticField.integer(),
    warn: diagnosticField.integer(),
  },
  level: "warn",
});

export const sessionTitleGenerationFailed = defineDiagnosticEvent({
  component: "session",
  event: "session.title_generation.failed",
  fields: {
    error: diagnosticField.externalError(),
  },
  level: "warn",
});

export const tokenUsageNormalization = defineDiagnosticEvent({
  component: "llm",
  event: "llm.usage.normalization",
  fields: {
    code: diagnosticField.stringEnum([
      "input-breakdown-conflict",
      "non-monotonic-cumulative-field",
      "raw-total-mismatch",
    ]),
    field: diagnosticField.optional(
      diagnosticField.stringEnum([
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "input_tokens",
        "output_tokens",
      ]),
    ),
    normalizedTotal: diagnosticField.optional(diagnosticField.integer()),
    protocol: diagnosticField.stringEnum([
      "anthropic",
      "openai-compatible",
      "openai-responses",
    ]),
    received: diagnosticField.optional(diagnosticField.integer()),
    retained: diagnosticField.optional(diagnosticField.integer()),
  },
  level: "debug",
});

const migrationFields = {
  conflicts: diagnosticField.integer(),
  copied: diagnosticField.integer(),
  merged: diagnosticField.integer(),
  skipped: diagnosticField.integer(),
};

export const configMigrationCompleted = defineDiagnosticEvent({
  component: "migration",
  event: "migration.config.completed",
  fields: migrationFields,
  level: "info",
});

export const dataMigrationCompleted = defineDiagnosticEvent({
  component: "migration",
  event: "migration.data.completed",
  fields: migrationFields,
  level: "info",
});

export const serverStarted = defineDiagnosticEvent({
  component: "server",
  event: "server.started",
  fields: {
    endpoint: diagnosticField.url(),
  },
  level: "info",
});

export const serverStartFailed = defineDiagnosticEvent({
  component: "server",
  event: "server.start.failed",
  fields: {
    error: diagnosticField.externalError(),
  },
  level: "error",
});

export const serverStopped = defineDiagnosticEvent({
  component: "server",
  event: "server.stopped",
  fields: {
    reason: diagnosticField.stringEnum([
      "idle",
      "requested",
      "signal",
      "startup-failed",
    ]),
  },
  level: "info",
});

export const serverStopFailed = defineDiagnosticEvent({
  component: "server",
  event: "server.stop.failed",
  fields: {
    error: diagnosticField.externalError(),
    reason: diagnosticField.stringEnum([
      "idle",
      "requested",
      "signal",
      "startup-failed",
    ]),
  },
  level: "error",
});

export const interactionCleanupFailure = defineDiagnosticEvent({
  component: "server",
  event: "ui.interaction.cleanup.failure",
  fields: {
    error: diagnosticField.externalError(),
    operation: diagnosticField.stringEnum(["disconnect", "shutdown"]),
  },
  level: "warn",
});

export const durationClockAnomaly = defineDiagnosticEvent({
  component: "diagnostics",
  event: "ui.duration.clock_anomaly",
  fields: { identity: diagnosticField.externalId("operation") },
  level: "warn",
});

export const sessionFilesCleanupFailed = defineDiagnosticEvent({
  component: "server",
  event: "session.files.cleanup.failed",
  fields: { error: diagnosticField.externalError() },
  level: "warn",
});
