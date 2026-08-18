import { describe, expect, it } from "vitest";
import { projectToolUiOutcome } from "./tool-ui-outcome.js";

describe("projectToolUiOutcome", () => {
  it.each([
    ["failed", { status: "failed" }, "failed"],
    ["timed_out", { status: "timed_out" }, "timed out"],
    ["cancelled", { status: "cancelled" }, "cancelled"],
    ["non-zero exit", { exitCode: 17 }, "exit code 17"],
  ] as const)(
    "folds completed tool metadata %s into a failed UI outcome",
    (_label, metadata, expectedError) => {
      expect(projectToolUiOutcome({ metadata, status: "completed" })).toEqual({
        error: expectedError,
        status: "failed",
      });
    },
  );

  it("prefers an explicit error over derived metadata summaries", () => {
    expect(
      projectToolUiOutcome({
        error: "permission denied",
        metadata: { exitCode: 126, status: "failed" },
        status: "error",
      }),
    ).toEqual({ error: "permission denied", status: "failed" });
  });

  it.each([
    [
      {
        error: "scheduler message",
        metadata: { error: "metadata message", status: "timed_out" },
        status: "error",
      },
      "scheduler message",
    ],
    [
      {
        metadata: { error: "metadata message", status: "timed_out" },
        status: "completed",
      },
      "metadata message",
    ],
    [{ metadata: { status: "timed_out" }, status: "completed" }, "timed out"],
    [{ metadata: { status: "cancelled" }, status: "completed" }, "cancelled"],
    [{ metadata: { exitCode: 9 }, status: "completed" }, "exit code 9"],
    [{ status: "error" }, "failed"],
  ] as const)(
    "uses the documented failure summary priority",
    (input, error) => {
      expect(projectToolUiOutcome(input)).toEqual({ error, status: "failed" });
    },
  );

  it.each([
    ["pending", "pending"],
    ["running", "running"],
    ["completed", "completed"],
    ["success", "completed"],
  ] as const)("maps %s to %s", (status, expectedStatus) => {
    expect(projectToolUiOutcome({ status })).toEqual({
      status: expectedStatus,
    });
  });

  it.each(["error", "aborted", "rejected", "cancelled"] as const)(
    "maps terminal %s status to failed",
    (status) => {
      expect(projectToolUiOutcome({ status }).status).toBe("failed");
    },
  );
});
