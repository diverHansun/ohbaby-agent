import type {
  UiShellJobAbandonInput,
  UiShellJobAbandonResult,
  UiShellJobList,
  UiShellJobListQuery,
  UiShellJobOutput,
  UiShellJobRow,
  UiShellJobStatus,
  UiShellJobStopResult,
  UiShellJobTarget,
} from "ohbaby-sdk";
import { vi } from "vitest";

export const NOW = 1_800_000_000_000;

export function taskRow(
  jobId: string,
  patch: Partial<UiShellJobRow> = {},
): UiShellJobRow {
  const status = patch.status ?? "running";
  return {
    jobId,
    rootSessionId: "root",
    sessionId: "root",
    ownerKind: "main",
    managedByCurrentBackend: true,
    canStop: status === "running",
    ownerName: "Main agent",
    command: `run ${jobId}`,
    description: null,
    mode: "background",
    status,
    stopReason: null,
    cleanup: status === "running" ? null : "confirmed",
    createdAt: NOW - 600_000,
    startedAt: NOW - 600_000,
    promotedAt: null,
    endedAt: status === "running" ? null : NOW - 300_000,
    resultReadyAt: null,
    settledAt: status === "running" ? null : NOW - 300_000,
    timeoutMs: null,
    exitCode: status === "completed" ? 0 : null,
    signal: null,
    trackingReleasedAt: null,
    ...patch,
  };
}

/** The "一般" scenario of TUI 06 §6, plus two foreground records. */
export function typicalRows(): UiShellJobRow[] {
  return [
    taskRow("dev", {
      description: "Dev server",
      command: "pnpm --filter ohbaby-web exec vite --port 5173",
      startedAt: NOW - 7_200_000,
    }),
    taskRow("watch", {
      description: "Watch tests",
      command: "pnpm exec vitest --watch",
      startedAt: NOW - 45_000,
    }),
    taskRow("unit", {
      description: "Unit tests",
      command: "pnpm test --run",
      status: "completed",
    }),
    taskRow("build", {
      description: "Build",
      command: "pnpm build",
      status: "failed",
      exitCode: 1,
    }),
    taskRow("tsc", {
      description: "Type check",
      command: "pnpm tsc --noEmit",
      status: "cancelled",
      stopReason: "user",
    }),
    taskRow("fg", {
      command: "git status",
      mode: "foreground",
      status: "completed",
      settledAt: null,
    }),
  ];
}

/** A backend over `rows`: background-only filter, owner scopes, paging. */
export function fakeTaskClient(rows: UiShellJobRow[]) {
  const listShellJobs = vi.fn(
    (input: UiShellJobListQuery): Promise<UiShellJobList> => {
      const scoped = rows.filter(
        (row) =>
          (input.mode === undefined ||
            row.mode === "background" ||
            (input.mode === "background-or-unconfirmed" &&
              row.cleanup === "unconfirmed" &&
              row.trackingReleasedAt === null)) &&
          (input.owner?.kind === "main"
            ? row.ownerKind === "main"
            : input.owner?.kind === "subagents"
              ? row.ownerKind === "subagent"
              : true),
      );
      const statusCounts: Record<UiShellJobStatus, number> = {
        running: 0,
        completed: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      };
      for (const row of scoped) statusCounts[row.status] += 1;
      const start = Number(input.cursor ?? 0);
      const limit = input.limit ?? 30;
      const next = start + limit;
      return Promise.resolve({
        rootSessionId: input.rootSessionId,
        runtimeEpoch: "epoch",
        revision: 1,
        rows: scoped.slice(start, next),
        hasMore: next < scoped.length,
        ...(next < scoped.length ? { nextCursor: String(next) } : {}),
        pendingStartCount: 0,
        filteredCount: scoped.length,
        statusCounts,
        unconfirmedCount: 0,
      });
    },
  );
  const getShellJobOutput = vi.fn(
    (input: UiShellJobTarget): Promise<UiShellJobOutput> => {
      const job = rows.find((row) => row.jobId === input.jobId);
      if (!job)
        return Promise.reject(
          Object.assign(new Error("Task was not found"), {
            code: "SHELL_JOB_NOT_FOUND",
          }),
        );
      return Promise.resolve({
        rootSessionId: input.rootSessionId,
        runtimeEpoch: "epoch",
        revision: 1,
        source: "live",
        sampledAt: NOW,
        job,
        output: Array.from(
          { length: 40 },
          (_, index) => `${job.jobId} line ${String(index)}`,
        ).join("\n"),
        tailAvailable: true,
        outputBytes: 400,
        outputComplete: null,
        outputCheckpointAt: NOW,
        outputTruncated: false,
        logAvailable: true,
        logPath: `/tmp/${job.jobId}.log`,
      });
    },
  );
  const stopShellJob = vi.fn(
    (input: UiShellJobTarget): Promise<UiShellJobStopResult> => {
      const index = rows.findIndex((row) => row.jobId === input.jobId);
      if (index < 0) return Promise.reject(new Error("missing"));
      const job = rows[index];
      rows[index] = {
        ...job,
        status: "cancelled",
        stopReason: "user",
        canStop: false,
        endedAt: NOW,
      };
      return Promise.resolve({
        rootSessionId: input.rootSessionId,
        runtimeEpoch: "epoch",
        revision: 2,
        outcome: "accepted",
        job: rows[index],
      });
    },
  );
  const abandonShellJob = vi.fn(
    (input: UiShellJobAbandonInput): Promise<UiShellJobAbandonResult> => {
      const index = rows.findIndex((row) => row.jobId === input.jobId);
      if (index < 0) return Promise.reject(new Error("missing"));
      rows[index] = { ...rows[index], trackingReleasedAt: NOW };
      return Promise.resolve({
        rootSessionId: input.rootSessionId,
        runtimeEpoch: "epoch",
        revision: 2,
        trackingReleasedAt: NOW,
        job: rows[index],
      });
    },
  );
  return { listShellJobs, getShellJobOutput, stopShellJob, abandonShellJob };
}
