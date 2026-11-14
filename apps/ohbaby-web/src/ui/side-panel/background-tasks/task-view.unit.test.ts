import type { UiShellJobOutput, UiShellJobRow } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  canCancel,
  groupCounts,
  shortDuration,
  taskNotes,
  taskOutputView,
  taskStatusLine,
  taskTitle,
  taskTrailing,
} from "./task-view.js";

const NOW = 10_000_000;

function row(patch: Partial<UiShellJobRow> = {}): UiShellJobRow {
  return {
    jobId: "job",
    rootSessionId: "root",
    sessionId: "root",
    ownerKind: "main",
    managedByCurrentBackend: true,
    canStop: true,
    ownerName: "Main agent",
    command: "pnpm dev\n--port 5173",
    description: null,
    mode: "background",
    status: "running",
    stopReason: null,
    cleanup: null,
    createdAt: NOW - 200_000,
    startedAt: NOW - 125_000,
    promotedAt: null,
    endedAt: null,
    resultReadyAt: null,
    settledAt: null,
    timeoutMs: null,
    exitCode: null,
    signal: null,
    trackingReleasedAt: null,
    ...patch,
  };
}

describe("background task view", () => {
  it("titles a task by its description, else the command's first line", () => {
    expect(taskTitle(row({ description: " Dev server " }))).toBe("Dev server");
    expect(taskTitle(row())).toBe("pnpm dev");
  });

  it("keeps list rows quiet: time, or a word only for failures and unknowns", () => {
    expect(taskTrailing(row(), NOW)).toEqual({ kind: "time", text: "2m" });
    expect(
      taskTrailing(
        row({
          status: "cancelled",
          stopReason: "user",
          endedAt: NOW - 120_000,
        }),
        NOW,
      ),
    ).toEqual({ kind: "time", text: "5s" });
    expect(taskTrailing(row({ status: "failed" }), NOW).text).toBe("Failed");
    expect(taskTrailing(row({ status: "timed_out" }), NOW).kind).toBe("failed");
    expect(taskTrailing(row({ status: "lost" }), NOW)).toEqual({
      kind: "unknown",
      text: "Unknown",
    });
    expect(shortDuration(45_000)).toBe("45s");
    expect(shortDuration(7_500_000)).toBe("2h 5m");
    expect(shortDuration(7_200_000)).toBe("2h");
  });

  it("writes the detail's status line in 03 §5.2 wording", () => {
    const ended = { endedAt: NOW - 5_000 };
    expect(taskStatusLine(row(), NOW)).toBe("Running · 2m 5s");
    expect(
      taskStatusLine(row({ ...ended, status: "completed", exitCode: 0 }), NOW),
    ).toBe("Completed · exit 0 · 2m 0s");
    expect(
      taskStatusLine(row({ ...ended, status: "failed", exitCode: 1 }), NOW),
    ).toBe("Failed · exit 1 · 2m 0s");
    expect(
      taskStatusLine(
        row({ ...ended, status: "failed", signal: "SIGKILL" }),
        NOW,
      ),
    ).toBe("Failed · SIGKILL · 2m 0s");
    expect(
      taskStatusLine(
        row({ ...ended, status: "cancelled", stopReason: "user" }),
        NOW,
      ),
    ).toMatch(/^Cancelled by you/u);
    expect(
      taskStatusLine(
        row({ ...ended, status: "cancelled", stopReason: "model" }),
        NOW,
      ),
    ).toMatch(/^Cancelled by the agent/u);
    expect(taskStatusLine(row({ status: "lost" }), NOW)).toBe("Result unknown");
  });

  it("offers Cancel only on running tasks this window may stop", () => {
    expect(canCancel(row())).toBe(true);
    expect(canCancel(row({ canStop: false }))).toBe(false);
    // The backend allows a cleanup retry on ended tasks; the page does not (D10).
    expect(
      canCancel(row({ status: "cancelled", cleanup: "unconfirmed" })),
    ).toBe(false);
  });

  it("says another window owns a task only while it runs (01 §1.3)", () => {
    expect(
      taskNotes(row({ canStop: false, managedByCurrentBackend: false })),
    ).toEqual(["Started from another ohbaby window. Cancel it there."]);
    // After a restart every old task reads as foreign; ended ones say nothing.
    expect(
      taskNotes(
        row({
          status: "completed",
          canStop: false,
          managedByCurrentBackend: false,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps at most two notes, in order", () => {
    expect(
      taskNotes(
        row({
          status: "lost",
          cleanup: "unconfirmed",
          stopReason: "shutdown",
        }),
      ),
    ).toEqual([
      "ohbaby couldn't confirm the process stopped. It may still be running.",
      "ohbaby stopped unexpectedly while this task was running.",
    ]);
    expect(
      taskNotes(row({ status: "cancelled", stopReason: "owner-ended" })),
    ).toEqual(["Stopped when its subagent finished."]);
  });

  it("tells a tail-only read from a cut log and from no saved output", () => {
    const output = {
      output: "tail",
      outputBytes: 40_000,
      outputTruncated: false,
      tailAvailable: true,
      logPath: "/tmp/job.log",
    } as UiShellJobOutput;
    expect(taskOutputView(output)).toMatchObject({
      tailOnly: true,
      logIncomplete: false,
      logPath: "/tmp/job.log",
      noSavedOutput: false,
    });
    expect(
      taskOutputView({
        ...output,
        outputBytes: 10,
        outputTruncated: true,
        tailAvailable: false,
        logPath: undefined,
      }),
    ).toMatchObject({
      tailOnly: false,
      logIncomplete: true,
      noSavedOutput: true,
    });
  });

  it("counts groups from the backend's status counts", () => {
    expect(
      groupCounts({
        running: 2,
        completed: 3,
        failed: 1,
        timed_out: 1,
        cancelled: 4,
        lost: 1,
      }),
    ).toEqual({ running: 2, done: 10 });
  });
});
