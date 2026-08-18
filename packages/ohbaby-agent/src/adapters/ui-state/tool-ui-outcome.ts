import type { UiToolCall } from "ohbaby-sdk";

const FAILED_METADATA_STATUSES = new Set(["failed", "timed_out", "cancelled"]);

export interface ToolUiOutcomeInput {
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
  readonly status: string;
}

export interface ToolUiOutcome {
  readonly error?: string;
  readonly status: UiToolCall["status"];
}

export function projectToolUiOutcome(input: ToolUiOutcomeInput): ToolUiOutcome {
  const metadataStatus = stringField(input.metadata, "status");
  const exitCode = numberField(input.metadata, "exitCode");
  const metadataFailed =
    (metadataStatus !== undefined &&
      FAILED_METADATA_STATUSES.has(metadataStatus)) ||
    (exitCode !== undefined && exitCode !== 0);

  if (!metadataFailed && input.status === "pending") {
    return { status: "pending" };
  }
  if (!metadataFailed && input.status === "running") {
    return { status: "running" };
  }
  if (
    !metadataFailed &&
    (input.status === "completed" || input.status === "success")
  ) {
    return { status: "completed" };
  }

  return {
    error:
      nonEmpty(input.error) ??
      nonEmpty(stringField(input.metadata, "error")) ??
      metadataStatusSummary(metadataStatus) ??
      (exitCode !== undefined && exitCode !== 0
        ? `exit code ${String(exitCode)}`
        : undefined) ??
      statusSummary(input.status),
    status: "failed",
  };
}

function metadataStatusSummary(status: string | undefined): string | undefined {
  if (status === "timed_out") {
    return "timed out";
  }
  return status !== undefined && FAILED_METADATA_STATUSES.has(status)
    ? status
    : undefined;
}

function statusSummary(status: string): string {
  if (status === "timed_out") {
    return "timed out";
  }
  return status === "cancelled" ? "cancelled" : "failed";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
