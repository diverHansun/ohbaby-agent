import { describe, expect, it, vi } from "vitest";
import type {
  UiShellJobList,
  UiShellJobListQuery,
  UiShellJobRow,
} from "../contract/shell-job.js";
import { createShellJobListReader } from "./shell-job-list-reader.js";

function row(jobId: string): UiShellJobRow {
  return {
    jobId,
    rootSessionId: "root",
    sessionId: "root",
    ownerKind: "main",
    managedByCurrentBackend: true,
    canStop: true,
    ownerName: "main",
    command: `echo ${jobId}`,
    description: null,
    mode: "background",
    status: "running",
    stopReason: null,
    cleanup: null,
    createdAt: 1,
    startedAt: 1,
    promotedAt: null,
    endedAt: null,
    resultReadyAt: null,
    settledAt: null,
    timeoutMs: null,
    exitCode: null,
    signal: null,
    trackingReleasedAt: null,
  };
}

/** A backend list over `total` rows, paged by a numeric cursor. */
function backend(
  total: number,
  revision = { value: 1 },
): ReturnType<
  typeof vi.fn<(input: UiShellJobListQuery) => Promise<UiShellJobList>>
> {
  return vi.fn((input: UiShellJobListQuery): Promise<UiShellJobList> => {
    const start = Number(input.cursor ?? 0);
    const limit = input.limit ?? 30;
    const ids = Array.from(
      { length: total },
      (_, index) => `job${String(index)}`,
    );
    const rows = ids.slice(start, start + limit).map(row);
    const next = start + limit;
    return Promise.resolve({
      rootSessionId: "root",
      runtimeEpoch: "epoch",
      revision: revision.value++,
      rows,
      hasMore: next < total,
      ...(next < total ? { nextCursor: String(next) } : {}),
      pendingStartCount: 0,
      filteredCount: total,
      statusCounts: {
        running: total,
        completed: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      unconfirmedCount: 0,
    });
  });
}

describe("shell job list reader", () => {
  it("loads pages and re-reads every loaded row on refresh, 100 at a time", async () => {
    const list = backend(250);
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", pageSize: 30 },
    );
    await reader.refresh();
    expect(reader.getSnapshot().rows).toHaveLength(30);
    for (let index = 0; index < 4; index += 1) await reader.loadMore();
    expect(reader.getSnapshot().rows).toHaveLength(150);
    list.mockClear();
    await reader.refresh();
    expect(list.mock.calls.map(([input]) => input.limit)).toEqual([100, 50]);
    expect(reader.getSnapshot().rows).toHaveLength(150);
    expect(reader.getSnapshot().meta?.nextCursor).toBe("150");
  });

  it("runs one follow-up for refreshes asked during a read instead of cancelling it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = backend(3);
    const list = vi.fn(async (input: UiShellJobListQuery) => {
      await gate;
      return inner(input);
    });
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", pageSize: 30 },
    );
    const first = reader.refresh();
    // Asked before the first read starts, a refresh shares it.
    expect(reader.refresh()).toBe(first);
    await vi.waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    const second = reader.refresh();
    const third = reader.refresh();
    expect(second).toBe(third);
    release();
    await Promise.all([first, second, third]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls.every(([input]) => !input.signal?.aborted)).toBe(
      true,
    );
  });

  it("keeps the last rows when a refresh fails", async () => {
    const list = backend(2);
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", pageSize: 30 },
    );
    await reader.refresh();
    list.mockRejectedValueOnce(new Error("offline"));
    await reader.refresh();
    expect(reader.getSnapshot()).toMatchObject({
      error: "offline",
      loading: false,
    });
    expect(reader.getSnapshot().rows).toHaveLength(2);
  });

  it("keeps a failed next page paused across refreshes until explicitly retried", async () => {
    const list = backend(40);
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", pageSize: 30 },
    );
    await reader.refresh();
    list.mockRejectedValueOnce(new Error("Next page is offline"));
    await reader.loadMore();

    // The current task list still updates on invalidation, but its scroll
    // sentinel must not start retrying the failed page on each refresh.
    await reader.refresh();
    expect(reader.getSnapshot()).toMatchObject({
      meta: { revision: 2, hasMore: true },
      moreError: "Next page is offline",
    });
    expect(reader.getSnapshot().rows).toHaveLength(30);
    expect(list.mock.calls.map(([input]) => input.cursor)).toEqual([
      undefined,
      "30",
      undefined,
    ]);

    await reader.loadMore();
    expect(reader.getSnapshot().rows).toHaveLength(40);
    expect(reader.getSnapshot().moreError).toBeUndefined();
    expect(list.mock.calls.at(-1)?.[0].cursor).toBe("30");
    reader.dispose();
  });

  it("drops a read whose query was replaced and starts the new one over", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = backend(5);
    const list = vi.fn(async (input: UiShellJobListQuery) => {
      if (input.owner?.kind === "main") await gate;
      return inner(input);
    });
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", owner: { kind: "main" }, pageSize: 2 },
    );
    const stale = reader.refresh();
    await Promise.resolve();
    const fresh = reader.select({ rootSessionId: "root", pageSize: 2 });
    release();
    await Promise.all([stale, fresh]);
    expect(list.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(list.mock.calls.at(-1)?.[0].owner).toBeUndefined();
    expect(reader.getSnapshot().rows).toHaveLength(2);
  });

  it("rejects rows from another chat and keeps a load-more failure apart", async () => {
    const list = backend(40);
    const reader = createShellJobListReader(
      { listShellJobs: list },
      { rootSessionId: "root", pageSize: 30 },
    );
    await reader.refresh();
    list.mockRejectedValueOnce(new Error("offline"));
    await reader.loadMore();
    expect(reader.getSnapshot()).toMatchObject({
      moreError: "offline",
      loadingMore: false,
    });
    expect(reader.getSnapshot().error).toBeUndefined();
    list.mockResolvedValueOnce({
      ...(await backend(1)({ rootSessionId: "root" })),
      rootSessionId: "other",
    });
    await reader.refresh();
    expect(reader.getSnapshot().error).toMatch(/another chat/u);
    reader.dispose();
  });
});
