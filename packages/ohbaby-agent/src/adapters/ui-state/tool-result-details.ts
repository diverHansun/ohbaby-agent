import type { UiToolResultDetails } from "ohbaby-sdk";

// Execution source is supplied by the scheduler, never by a tool's metadata.
// Legacy records lack this marker and intentionally retain their raw fallback.
export function projectToolResultDetails(
  name: string | undefined,
  metadata: Record<string, unknown> | undefined,
  status: string,
): UiToolResultDetails | undefined {
  if (metadata?.uiToolSource !== "builtin") return undefined;
  const bool = (key: string): boolean | undefined =>
    typeof metadata[key] === "boolean" ? metadata[key] : undefined;
  const integer = (key: string, min = 0): number | undefined => {
    const value = metadata[key];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min
      ? value
      : undefined;
  };
  const text = (key: string, max = 32768): string | undefined =>
    typeof metadata[key] === "string" && Buffer.byteLength(metadata[key]) <= max
      ? metadata[key]
      : undefined;
  if (name === "write" || name === "edit") {
    // Failed execution must not advertise a simulated change as committed.
    if (status !== "success" && status !== "completed") return undefined;
    return {
      kind: "mutation",
      diff: bool("diffOmitted") === false ? text("diff") : undefined,
      diffOmissionReason:
        bool("diffOmitted") === true
          ? (text("diffOmissionReason", 1024) ?? "preview unavailable")
          : undefined,
      created: bool("created"),
      dryRun: bool("dryRun"),
    };
  }
  if (name === "read")
    return {
      kind: "read",
      startLine: integer("startLine", 1),
      shownLineCount: integer("shownLineCount"),
      hasMore: bool("hasMore"),
    };
  if (name === "glob" || name === "grep")
    return {
      kind: "search",
      unit: name === "glob" ? "files" : "matches",
      count: integer(name === "glob" ? "count" : "matchCount"),
      scanComplete: bool("scanComplete"),
      displayLimited: bool("displayLimited"),
    };
  if (name === "bash") {
    const shellStatus = text("status", 32);
    const knownStatus =
      shellStatus === "running" ||
      shellStatus === "completed" ||
      shellStatus === "failed" ||
      shellStatus === "timed_out" ||
      shellStatus === "cancelled"
        ? shellStatus
        : undefined;
    return {
      kind: "bash",
      exitCode: integer("exitCode", -2147483648),
      jobId: text("jobId", 256),
      status: knownStatus,
      outputTruncated: bool("truncated"),
    };
  }
  return undefined;
}
