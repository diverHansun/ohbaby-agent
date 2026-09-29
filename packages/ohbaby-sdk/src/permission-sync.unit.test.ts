import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiPermissionBinding,
  UiPermissionSnapshot,
} from "./permission.js";
import type { UiPermissionRequest } from "./snapshot.js";
import {
  createPermissionSync,
  type PermissionSyncEvent,
} from "./permission-sync.js";

const binding: UiPermissionBinding = {
  permissionEpoch: "epoch",
  rootSessionId: "a",
  bindingGeneration: 1,
};
function request(id = "p1", rootSessionId = "a"): UiPermissionRequest {
  return {
    id,
    rootSessionId,
    sessionId: rootSessionId,
    runId: "run",
    callId: id,
    messageId: "message",
    title: "Allow edit?",
    description: "src/a.ts",
    choices: [{ id: "allow_once", label: "Allow once", intent: "allow" }],
    createdAt: 1,
  };
}
function snapshot(
  permissionRevision = 0,
  requests: readonly UiPermissionRequest[] = [],
  scope = binding,
): UiPermissionSnapshot {
  return { ...scope, permissionRevision, requests };
}
function event(
  permissionRevision: number,
  id = `p${String(permissionRevision)}`,
  scope = binding,
): PermissionSyncEvent {
  return {
    type: "permission.requested",
    ...scope,
    rootSessionId: scope.rootSessionId ?? "a",
    permissionRevision,
    request: request(id, scope.rootSessionId ?? "a"),
  };
}
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
});
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function harness(
  limits: Parameters<typeof createPermissionSync>[0]["limits"] = {},
): {
  sync: ReturnType<typeof createPermissionSync>;
  calls: {
    binding: UiPermissionBinding;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<UiPermissionSnapshot>>;
  }[];
} {
  const calls: {
    binding: UiPermissionBinding;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<UiPermissionSnapshot>>;
  }[] = [];
  const sync = createPermissionSync({
    limits,
    query(scope, signal) {
      const result = deferred<UiPermissionSnapshot>();
      calls.push({ binding: scope, signal, result });
      return result.promise;
    },
  });
  cleanup.push(() => {
    sync.dispose();
  });
  return { sync, calls };
}

describe("permission sync", () => {
  it("waits for confirmed binding and installs baseline plus contiguous buffered updates", async () => {
    const { sync, calls } = harness();
    expect(calls).toHaveLength(0);
    sync.begin(binding, 1);
    sync.receive(event(2));
    sync.receive({
      type: "permission.resolved",
      ...binding,
      rootSessionId: "a",
      permissionRevision: 3,
      requestId: "p1",
      sessionId: "a",
      reason: "once",
    });
    expect(sync.getState().status).toBe("syncing");
    calls[0].result.resolve(snapshot(1, [request()]));
    await flush();
    expect(sync.getState()).toMatchObject({
      status: "ready",
      permissionRevision: 3,
      requests: [request("p2")],
      attempts: 1,
    });
  });
  it("ignores other roots and duplicate versions without changing readiness", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(1, [request()]));
    await flush();
    sync.receive(event(1));
    sync.receive(event(99, "other", { ...binding, rootSessionId: "b" }));
    expect(sync.getState()).toMatchObject({
      status: "ready",
      permissionRevision: 1,
      requests: [request()],
    });
    expect(calls).toHaveLength(1);
  });
  it("requeries gaps and does not mark a partial baseline ready", async () => {
    vi.useFakeTimers();
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    sync.receive(event(3));
    calls[0].result.resolve(snapshot(1));
    await flush();
    expect(sync.getState().status).toBe("syncing");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    calls[1].result.resolve(snapshot(3, [request("p3")]));
    await flush();
    expect(sync.getState()).toMatchObject({
      status: "ready",
      permissionRevision: 3,
    });
  });
  it("fences stale A to B to A snapshots and cancels superseded reads", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    sync.begin({ ...binding, rootSessionId: "b", bindingGeneration: 2 }, 1);
    sync.begin({ ...binding, bindingGeneration: 3 }, 1);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(true);
    calls[2].result.resolve(
      snapshot(0, [], { ...binding, bindingGeneration: 3 }),
    );
    await flush();
    calls[0].result.resolve(snapshot(50, [request("stale")]));
    await flush();
    expect(sync.getState()).toMatchObject({
      status: "ready",
      permissionRevision: 0,
      requests: [],
    });
    sync.receive(event(51));
    expect(sync.getState().requests).toEqual([]);
  });
  it("disables old cards immediately on disconnect and recovers on a new connection", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(1, [request()]));
    await flush();
    sync.disconnect();
    expect(sync.getState()).toMatchObject({
      status: "syncing",
      requests: [request()],
    });
    sync.receive(event(2));
    expect(sync.getState().permissionRevision).toBe(1);
    sync.begin(binding, 2);
    calls[1].result.resolve(snapshot(2));
    await flush();
    expect(sync.getState()).toMatchObject({
      status: "ready",
      requests: [],
      attempts: 1,
    });
  });
  it("keeps a ready unchanged binding live through repeated confirmations without consuming queries", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(1, [request()]));
    await flush();
    for (let confirmation = 0; confirmation < 8; confirmation++) {
      sync.begin(binding, 1);
      await flush();
      expect(sync.getState()).toMatchObject({ status: "ready", attempts: 1 });
      expect(calls).toHaveLength(1);
    }
    sync.receive(event(2, "later"));
    expect(
      sync
        .getState()
        .requests.map((item) => item.id)
        .sort(),
    ).toEqual(["later", "p1"]);
    sync.begin(binding, 2);
    expect(calls).toHaveLength(2);
    expect(sync.getState()).toMatchObject({ status: "syncing", attempts: 1 });
    calls[1].result.resolve(snapshot(2, [request("later")]));
    await flush();
    expect(sync.getState().status).toBe("ready");
  });

  it("bounds cumulative attempts across gaps and repeated hello/resync triggers", async () => {
    vi.useFakeTimers();
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    for (let attempt = 0; attempt < 4; attempt++) {
      sync.begin(binding, 1);
      sync.resync();
      sync.receive(event(99));
      expect(calls).toHaveLength(attempt + 1);
      calls[attempt].result.resolve(snapshot(0));
      await flush();
      if (attempt < 3)
        await vi.advanceTimersByTimeAsync([100, 250, 500][attempt]);
    }
    expect(sync.getState()).toMatchObject({ status: "error", attempts: 4 });
    sync.begin(binding, 1);
    sync.resync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(4);
    sync.retry();
    expect(calls).toHaveLength(5);
    calls[4].result.resolve(snapshot());
    await flush();
    expect(sync.getState()).toMatchObject({ status: "ready", attempts: 1 });
  });
  it("times out non-cooperating HTTP reads and releases every timer on disposal", async () => {
    vi.useFakeTimers();
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    sync.dispose();
    expect(calls[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    calls[1].result.resolve(snapshot());
    await flush();
    expect(sync.getState().status).not.toBe("ready");
  });
  it.each(["count", "bytes"])(
    "discards an overflowing %s buffer and rejects its old candidate",
    async (kind) => {
      vi.useFakeTimers();
      const { sync, calls } = harness({
        maxBufferedEvents: kind === "count" ? 1 : 1024,
        maxBufferedBytes: kind === "bytes" ? 1 : 2 * 1024 * 1024,
      });
      sync.begin(binding, 1);
      sync.receive(event(1));
      sync.receive(event(2));
      expect(calls[0].signal.aborted).toBe(true);
      calls[0].result.resolve(snapshot());
      await flush();
      expect(sync.getState().status).toBe("syncing");
      await vi.advanceTimersByTimeAsync(100);
      calls[1].result.resolve(snapshot(2));
      await flush();
      expect(sync.getState()).toMatchObject({
        status: "ready",
        permissionRevision: 2,
        requests: [],
      });
    },
  );
  it("does not auto-retry an unavailable scope", async () => {
    vi.useFakeTimers();
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.reject(
      Object.assign(new Error("Frozen"), { code: "PERMISSION_UNAVAILABLE" }),
    );
    await flush();
    expect(sync.getState().status).toBe("unavailable");
    sync.resync();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(1);
  });
  it("an unavailable event aborts the baseline and cannot be overwritten by its late result", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    sync.receive({
      type: "permission.unavailable",
      ...binding,
      reason: "Frozen",
    });
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].result.resolve(snapshot());
    await flush();
    expect(sync.getState().status).toBe("unavailable");
  });
  it("ignores global unavailability from an older binding generation", async () => {
    const { sync, calls } = harness();
    const current = { ...binding, bindingGeneration: 3 };
    sync.begin(current, 1);
    calls[0].result.resolve(snapshot(0, [], current));
    await flush();
    sync.receive({
      type: "permission.unavailable",
      ...binding,
      rootSessionId: null,
      reason: "Old failure",
    });
    expect(sync.getState().status).toBe("ready");
    sync.receive({
      type: "permission.unavailable",
      ...current,
      rootSessionId: null,
      reason: "Current failure",
    });
    expect(sync.getState().status).toBe("unavailable");
  });
  it("rejects a stale or foreign snapshot without installing it", async () => {
    vi.useFakeTimers();
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(
      snapshot(1, [request()], { ...binding, bindingGeneration: 0 }),
    );
    await flush();
    expect(sync.getState().status).toBe("syncing");
    expect(sync.getState().requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
  });
  it("clears old epoch cards and handles an empty selection without querying globally", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(1, [request()]));
    await flush();
    sync.begin({ ...binding, permissionEpoch: "new" }, 2);
    expect(sync.getState().requests).toEqual([]);
    sync.begin({ ...binding, rootSessionId: null, bindingGeneration: 3 }, 2);
    expect(sync.getState()).toMatchObject({ status: "idle", requests: [] });
    expect(calls).toHaveLength(2);
  });
  it("keeps an unavailable root closed across retry and reconnect until its epoch changes", () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    sync.receive({
      type: "permission.unavailable",
      ...binding,
      reason: "Frozen",
    });
    sync.retry();
    sync.begin(binding, 2);
    expect(calls).toHaveLength(1);
    expect(sync.getState().status).toBe("unavailable");
    sync.begin({ ...binding, permissionEpoch: "new" }, 3);
    expect(calls).toHaveLength(2);
  });
  it("does not install a baseline containing repeated request IDs", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(2, [request(), request()]));
    await flush();
    expect(sync.getState().status).not.toBe("ready");
    expect(sync.getState().requests).toEqual([]);
  });
  it("does not roll a live same-scope revision backward during a resync", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    calls[0].result.resolve(snapshot(4));
    await flush();
    sync.resync();
    calls[1].result.resolve(snapshot(2, [request()]));
    await flush();
    expect(sync.getState().status).not.toBe("ready");
    expect(sync.getState().permissionRevision).toBe(4);
  });
  it("coalesces resync-required with the current query without resetting its budget", async () => {
    const { sync, calls } = harness();
    sync.begin(binding, 1);
    sync.receive({ type: "permission.resync-required", ...binding });
    expect(calls).toHaveLength(1);
    calls[0].result.resolve(snapshot());
    await flush();
    sync.receive({ type: "permission.resync-required", ...binding });
    expect(calls).toHaveLength(2);
    expect(sync.getState().attempts).toBe(2);
  });
});
