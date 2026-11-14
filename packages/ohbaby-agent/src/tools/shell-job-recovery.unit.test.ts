import { shellJobFixture as record } from "./fixtures/shell-job.js";
import { describe, expect, it, vi } from "vitest";
import { ShellJobRecovery } from "./shell-job-recovery.js";
import { InMemoryShellJobStore } from "./shell-job-store.js";
import type { ProcessIdentity } from "../shell/process-identity.js";

const RecoveryStore = InMemoryShellJobStore;

const backend = { ownerId: "new", pid: 20, startToken: "new-owner" };
const inspect = (pid: number): Promise<ProcessIdentity> =>
  Promise.resolve(
    pid === 10
      ? { state: "absent" }
      : {
          state: "present",
          pid,
          pgid: pid,
          startToken: pid === 42 ? "target" : "new-owner",
        },
  );

describe("shell task recovery", () => {
  it("queries only probe; vanished groups settle lost, with checkpoint facts preserved", async () => {
    const store = new RecoveryStore();
    await store.insert(record());
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: (): "stopped" => "stopped",
      signalGroup,
    });
    expect(await recovery.refresh("job")).toMatchObject({
      status: "lost",
      cleanup: "confirmed",
      outputBytes: 12,
      outputTail: "checkpoint",
      outputComplete: false,
      noticeState: "pending",
    });
    expect(store.get("job")?.settledAt).not.toBeNull();
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("does not take over a living or unidentifiable backend", async () => {
    for (const owner of [
      { state: "present", pid: 10, pgid: 10, startToken: "owner" },
      { state: "unknown", reason: "denied" },
    ] as const) {
      const store = new RecoveryStore();
      await store.insert(record());
      const signalGroup = vi.fn();
      const recovery = new ShellJobRecovery({
        store,
        backend,
        inspect: (): Promise<ProcessIdentity> => Promise.resolve(owner),
        probeGroup: (): "running" => "running",
        signalGroup,
      });
      await recovery.recover("job");
      expect(store.get("job")?.status).toBe("running");
      expect(signalGroup).not.toHaveBeenCalled();
      await expect(recovery.assertCanManage("job")).rejects.toMatchObject({
        code: "SHELL_JOB_OTHER_BACKEND",
      });
    }
  });

  it("never signals a reused, unknown or vanished leader while its group remains", async () => {
    for (const target of [
      { state: "present", pid: 42, pgid: 42, startToken: "reused" },
      { state: "absent" },
      { state: "unknown", reason: "denied" },
    ] as const) {
      const store = new RecoveryStore();
      await store.insert(record());
      const signalGroup = vi.fn();
      const recovery = new ShellJobRecovery({
        store,
        backend,
        inspect: (pid): Promise<ProcessIdentity> =>
          pid === 10 ? inspect(pid) : Promise.resolve(target),
        probeGroup: (): "running" => "running",
        signalGroup,
      });
      expect(await recovery.recover("job")).toMatchObject({
        status: "lost",
        cleanup: "unconfirmed",
        settledAt: null,
      });
      expect(signalGroup).not.toHaveBeenCalled();
    }
  });

  it("preserves existing terminal outcomes and suppresses lost child notifications", async () => {
    const store = new RecoveryStore();
    await store.insert(record({ status: "timed_out", stopReason: "timeout" }));
    await store.insert(record({ jobId: "child", contextScopeId: "child" }));
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: (): "stopped" => "stopped",
    });
    expect(await recovery.refresh("job")).toMatchObject({
      status: "timed_out",
      stopReason: "timeout",
    });
    expect(await recovery.refresh("child")).toMatchObject({
      status: "lost",
      noticeState: "suppressed",
    });
  });

  it("retains unidentified startup reservations and permits only explicit user abandonment", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        status: null,
        pid: null,
        pgid: null,
        processStartToken: null,
        startedAt: null,
      }),
    );
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      signalGroup,
    });
    expect(await recovery.recover("job")).toMatchObject({
      status: "lost",
      cleanup: "unconfirmed",
      settledAt: null,
    });
    await expect(recovery.abandon("job", false)).rejects.toThrow("confirm");
    const abandoned = await recovery.abandon("job", true);
    expect(abandoned).toMatchObject({ status: "lost", cleanup: "unconfirmed" });
    expect(abandoned.trackingReleasedAt).not.toBeNull();
    expect(await recovery.abandon("job", true)).toEqual(abandoned);
    await recovery.recover("job");
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("rechecks identity before escalation and releases the recovery claim", async () => {
    const store = new RecoveryStore();
    await store.insert(record());
    const signalGroup = vi.fn();
    let targetQueries = 0;
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect: (pid): Promise<ProcessIdentity> => {
        if (pid === 42 && ++targetQueries > 1)
          return Promise.resolve({
            state: "present",
            pid,
            pgid: pid,
            startToken: "reused",
          });
        return inspect(pid);
      },
      probeGroup: (): "running" => "running",
      signalGroup,
      termGraceMs: 0,
      observationMs: 0,
    });
    await recovery.recover("job");
    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(signalGroup).toHaveBeenCalledWith(42, "SIGTERM");
    expect(store.get("job")).toMatchObject({
      status: "lost",
      cleanup: "unconfirmed",
      recoveryClaim: null,
    });
  });

  it("allows only one recovery actor to signal and excludes user abandonment while claimed", async () => {
    const store = new RecoveryStore();
    await store.insert(record({ status: "lost", cleanup: "unconfirmed" }));
    let releaseInspection: () => void = () => undefined;
    let enteredInspection: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredInspection = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    let stopped = false;
    const signalGroup = vi.fn(() => {
      stopped = true;
    });
    const options = {
      store,
      backend,
      inspect: async (pid: number): Promise<ProcessIdentity> => {
        if (pid === 42) {
          enteredInspection();
          await pause;
        }
        return inspect(pid);
      },
      probeGroup: (): "running" | "stopped" =>
        stopped ? "stopped" : "running",
      signalGroup,
    };
    const first = new ShellJobRecovery(options);
    const second = new ShellJobRecovery({
      ...options,
      backend: { ownerId: "other", pid: 30, startToken: "new-owner" },
    });
    const recovering = first.recover("job");
    await entered;
    try {
      await second.recover("job");
      await expect(second.abandon("job", true)).rejects.toMatchObject({
        code: "SHELL_JOB_CLEANUP_BUSY",
      });
    } finally {
      releaseInspection();
    }
    await recovering;
    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(store.get("job")).toMatchObject({
      status: "lost",
      cleanup: "confirmed",
      recoveryClaim: null,
    });
  });

  it("does not overwrite a terminal result saved while checking the old owner", async () => {
    const store = new RecoveryStore();
    await store.insert(record());
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect: async (pid): Promise<ProcessIdentity> => {
        if (pid === 10) {
          await store.update("job", {
            status: "completed",
            cleanup: "confirmed",
            settledAt: 9,
            outputComplete: true,
            noticeState: "accepted",
          });
          return { state: "absent" };
        }
        return inspect(pid);
      },
      probeGroup: (): "running" => "running",
      signalGroup,
    });
    expect(await recovery.recover("job")).toMatchObject({
      status: "completed",
      cleanup: "confirmed",
      settledAt: 9,
      noticeState: "accepted",
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("does not roll back notification delivery during a later cleanup probe", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        status: "lost",
        noticeState: "pending",
        cleanup: "unconfirmed",
      }),
    );
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect: async (pid): Promise<ProcessIdentity> => {
        await store.update("job", { noticeState: "accepted" });
        return inspect(pid);
      },
      probeGroup: (): "stopped" => "stopped",
    });
    expect(await recovery.refresh("job")).toMatchObject({
      status: "lost",
      noticeState: "accepted",
      cleanup: "confirmed",
    });
  });

  it("returns the same abandonment fact to concurrent requests", async () => {
    const store = new RecoveryStore();
    await store.insert(record({ status: "lost", cleanup: "unconfirmed" }));
    const options = {
      store,
      backend,
      inspect,
      probeGroup: (): "running" => "running",
    };
    const first = new ShellJobRecovery(options);
    const results = await Promise.all([
      first.abandon("job", true),
      first.abandon("job", true),
    ]);
    expect(results[0].trackingReleasedAt).not.toBeNull();
    expect(results[1].trackingReleasedAt).toEqual(
      results[0].trackingReleasedAt,
    );
  });
  it("never reacquires a confirmed group when finishing an old persistence responsibility", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        status: "completed",
        cleanup: "confirmed",
        settledAt: null,
        outputComplete: false,
      }),
    );
    const signalGroup = vi.fn();
    const probeGroup = vi.fn((): "running" => "running");
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup,
      signalGroup,
    });
    expect(await recovery.recover("job")).toMatchObject({
      status: "completed",
      cleanup: "confirmed",
      outputComplete: false,
    });
    expect(store.get("job")?.settledAt).not.toBeNull();
    expect(probeGroup).not.toHaveBeenCalled();
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("initializes a notice for a terminal result whose owner died before publishing readiness", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        status: "timed_out",
        stopReason: "timeout",
        noticeState: null,
        resultReadyAt: null,
      }),
    );
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: (): "stopped" => "stopped",
    });
    expect(await recovery.recover("job")).toMatchObject({
      status: "timed_out",
      stopReason: "timeout",
      noticeState: "pending",
    });
  });

  it("a concurrent read-only refresh cannot consume the startup recovery opportunity", async () => {
    const store = new RecoveryStore();
    await store.insert(record());
    let stopped = false;
    const signalGroup = vi.fn(() => {
      stopped = true;
    });
    const options = {
      store,
      backend,
      inspect,
      probeGroup: (): "running" | "stopped" =>
        stopped ? "stopped" : "running",
      signalGroup,
    };
    const reader = new ShellJobRecovery(options);
    const recovery = new ShellJobRecovery({
      ...options,
      backend: { ...backend, ownerId: "other" },
    });
    await Promise.all([reader.refresh("job"), recovery.recover("job")]);
    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(store.get("job")).toMatchObject({
      status: "lost",
      cleanup: "confirmed",
      recoveryClaim: null,
    });
  });
});
