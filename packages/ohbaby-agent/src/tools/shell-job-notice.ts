import type { ShellJobRecord, ShellJobStatus } from "./shell-job-store.js";

export function shellJobStatusLine(input: {
  readonly status: ShellJobStatus;
  readonly outputBytes: number | null;
  readonly outputComplete?: boolean | null;
  readonly outputCheckpointAt?: number | null;
  readonly outputPath: string | null;
  readonly cleanup?: string | null;
  readonly stopReason?: string | null;
  readonly elapsedMs?: number | null;
}): string {
  const reason = input.stopReason ? `: ${input.stopReason}` : "";
  const elapsed =
    input.elapsedMs === null || input.elapsedMs === undefined
      ? ""
      : `; elapsed ${String(input.elapsedMs)} ms`;
  const cleanup = input.cleanup ? `, cleanup: ${input.cleanup}` : "";
  const log = input.outputPath ? `log: ${input.outputPath}` : "log unavailable";
  const incomplete =
    input.outputComplete === false ||
    (input.outputCheckpointAt !== null &&
      input.outputCheckpointAt !== undefined &&
      input.outputComplete !== true);
  const bytes =
    input.outputBytes === null
      ? "captured bytes unknown"
      : `${incomplete ? "at least " : ""}${String(input.outputBytes)} bytes captured`;
  const completeness = incomplete ? "; output incomplete" : "";
  const checkpoint =
    input.outputCheckpointAt === null || input.outputCheckpointAt === undefined
      ? ""
      : `; checkpoint ${new Date(input.outputCheckpointAt).toISOString()}`;
  return `Status: ${input.status}${reason}${cleanup}${elapsed}; ${bytes}${completeness}${checkpoint}; ${log}.`;
}

/** Initialize exactly once when durable result facts are ready. Reads never consume notices. */
export function initialShellJobNoticeState(
  input: Pick<
    ShellJobRecord,
    "mode" | "status" | "stopReason" | "contextScopeId"
  >,
): "pending" | "suppressed" {
  if (input.mode !== "background") return "suppressed";
  if (input.status === "lost")
    return input.contextScopeId === null ? "pending" : "suppressed";
  return input.status === "completed" ||
    input.status === "failed" ||
    input.status === "timed_out" ||
    (input.status === "cancelled" &&
      (input.stopReason === "user" || input.stopReason === "output-limit"))
    ? "pending"
    : "suppressed";
}
