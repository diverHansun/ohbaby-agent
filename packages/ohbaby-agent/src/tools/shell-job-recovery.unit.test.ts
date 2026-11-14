import { ShellJobRegistry } from "./shell-job-registry.js";
import { getSourceCleanupState } from "../core/tool-scheduler/source-cleanup.js";
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
  it("refreshes dead foreign running rows without signalling, leaving live foreign rows untouched", async () => {
    const store = new RecoveryStore();
    await store.insert(record({ jobId: "dead", cleanup: null }));
    await store.insert(
      record({
        jobId: "live",
        cleanup: null,
        ownerPid: 20,
        ownerStartToken: "new-owner",
        ownerId: "live-owner",
      }),
    );
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: () => "stopped",
      signalGroup,
    });
    const registry = new ShellJobRegistry({
      store,
      recovery,
      killTree: () => undefined,
    });
    await registry.refreshRoot("s");
    expect(store.get("dead")).toMatchObject({
      status: "lost",
      cleanup: "confirmed",
      noticeState: "pending",
    });
    expect(store.get("live")).toMatchObject({
      status: "running",
      cleanup: null,
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("does not signal after a binding change during target identity inspection", async () => {
    const store = new RecoveryStore();
    await store.insert(record({ jobId: "guard-signal" }));
    let valid = true;
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      probeGroup: () => "running",
      signalGroup,
      inspect: async (pid) => {
        if (pid === 42) valid = false;
        return inspect(pid);
      },
    });
    await expect(
      recovery.recoverForUser("guard-signal", () => {
        if (!valid) throw new Error("binding changed");
      }),
    ).rejects.toThrow("binding changed");
    expect(signalGroup).not.toHaveBeenCalled();
    expect(store.get("guard-signal")?.recoveryClaim).toBeNull();
  });

  it("retains the source guard when the initial recovery claim write fails", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        jobId: "failed-claim",
        rootSessionId: "failed-root",
        workspaceKey: "/project",
        cleanup: null,
      }),
    );
    const original = store.compareAndUpdate.bind(store);
    const fail = vi
      .spyOn(store, "compareAndUpdate")
      .mockRejectedValueOnce(new Error("write failed"));
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      trackSourceCleanup: true,
      probeGroup: () => "running",
    });
    await expect(recovery.recover("failed-claim")).rejects.toThrow(
      "write failed",
    );
    expect(store.get("failed-claim")).toMatchObject({
      status: "running",
      cleanup: null,
    });
    expect(
      getSourceCleanupState({
        sessionId: "s",
        rootSessionId: "failed-root",
        workspaceKey: "/project",
        messageId: "m",
        callId: "c",
      }),
    ).toBe("unconfirmed");
    fail.mockImplementation(original);
    await store.update("failed-claim", {
      cleanup: "confirmed",
      settledAt: 1,
      status: "lost",
    });
    getSourceCleanupState({
      sessionId: "s",
      rootSessionId: "failed-root",
      workspaceKey: "/project",
      messageId: "m",
      callId: "c",
    });
  });
  it("confirms an already vanished group before rejecting unnecessary abandonment", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({ jobId: "already-gone", status: "lost", cleanup: "unconfirmed" }),
    );
    const signalGroup = vi.fn();
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: () => "stopped",
      signalGroup,
    });
    const abandoning = recovery.abandon("already-gone", true);
    await expect(abandoning).rejects.toMatchObject({
      code: "SHELL_JOB_ABANDON_NOT_ALLOWED",
    });
    await expect(abandoning).rejects.toThrow("already confirmed");
    expect(store.get("already-gone")).toMatchObject({
      cleanup: "confirmed",
      trackingReleasedAt: null,
    });
    expect(signalGroup).not.toHaveBeenCalled();
  });

  it("rechecks binding and local handle inside the abandon writer", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        jobId: "abandon-guard",
        status: "lost",
        cleanup: "unconfirmed",
      }),
    );
    let local = false;
    let valid = true;
    const original = store.compareAndUpdate.bind(store);
    vi.spyOn(store, "compareAndUpdate").mockImplementation(
      async (id, expected, patch, guard) => {
        if (patch.trackingReleasedAt !== undefined) {
          local = true;
          valid = false;
        }
        return original(id, expected, patch, guard);
      },
    );
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: () => "unknown",
      hasLocalHandle: () => local,
    });
    await expect(
      recovery.abandon("abandon-guard", true, () => {
        if (!valid) throw new Error("binding changed");
      }),
    ).rejects.toThrow("binding changed");
    expect(store.get("abandon-guard")?.trackingReleasedAt).toBeNull();
    valid = true;
    local = false;
    await expect(recovery.abandon("abandon-guard", true)).rejects.toMatchObject(
      { code: "SHELL_JOB_ABANDON_NOT_ALLOWED" },
    );
    expect(store.get("abandon-guard")?.trackingReleasedAt).toBeNull();
  });

  it("rebuilds a recovered workspace guard until confirmed or abandoned", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        jobId: "recover-guard",
        rootSessionId: "guard-root",
        workspaceKey: "/old",
      }),
    );
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      trackSourceCleanup: true,
      probeGroup: () => "unknown",
    });
    await recovery.recover("recover-guard");
    const owner = {
      sessionId: "child",
      rootSessionId: "guard-root",
      workspaceKey: "/old",
      messageId: "m",
      callId: "c",
    };
    expect(getSourceCleanupState(owner)).toBe("unconfirmed");
    expect(
      getSourceCleanupState({ ...owner, workspaceKey: "/new" }),
    ).toBeUndefined();
    expect(
      getSourceCleanupState({ ...owner, rootSessionId: "other" }),
    ).toBeUndefined();
    const second = new ShellJobRecovery({
      store,
      backend: { ...backend, ownerId: "second" },
      inspect,
      trackSourceCleanup: true,
      probeGroup: () => "unknown",
    });
    await second.abandon("recover-guard", true);
    expect(store.get("recover-guard")?.cleanup).toBe("unconfirmed");
    expect(getSourceCleanupState(owner)).toBeUndefined();
  });
  it("guards all workspaces for legacy rows with an unknown launch workspace", async () => {
    const store = new RecoveryStore();
    await store.insert(
      record({
        jobId: "legacy-guard",
        rootSessionId: "legacy-root",
        workspaceKey: null,
      }),
    );
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      trackSourceCleanup: true,
      probeGroup: () => "unknown",
    });
    await recovery.recover("legacy-guard");
    const owner = {
      sessionId: "legacy-root",
      rootSessionId: "legacy-root",
      workspaceKey: "/moved",
      messageId: "m",
      callId: "c",
    };
    expect(getSourceCleanupState(owner)).toBe("unconfirmed");
    await store.update("legacy-guard", { cleanup: "confirmed" });
    expect(getSourceCleanupState(owner)).toBeUndefined();
  });
  it("does not emit repeated invalidations for an unchanged observation", async () => {
    const store = new RecoveryStore();
    await store.insert(record());
    const listener = vi.fn();
    store.subscribe(listener);
    const recovery = new ShellJobRecovery({
      store,
      backend,
      inspect,
      probeGroup: () => "unknown",
    });
    await recovery.refresh("job");
    await recovery.refresh("job");
    await recovery.refresh("job");
    expect(listener).toHaveBeenCalledTimes(1);
  });

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

  it.each(["lost", "running"] as const)(
    "reports user acceptance only for the recovery actor that signals (%s)",
    async (status) => {
      const store = new RecoveryStore();
      await store.insert(record({ status, cleanup: "unconfirmed" }));
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
      const recovering = first.recoverForUser("job");
      await entered;
      try {
        expect((await second.recoverForUser("job")).accepted).toBe(false);
        if (status === "running") {
          const registry = new ShellJobRegistry({
            store,
            recovery: second,
            killTree: () => undefined,
          });
          await expect(
            registry.stopForUser("job", "s", undefined),
          ).rejects.toMatchObject({ code: "SHELL_JOB_CLEANUP_BUSY" });
        }
        await expect(second.abandon("job", true)).rejects.toMatchObject({
          code:
            status === "running"
              ? "SHELL_JOB_ABANDON_NOT_ALLOWED"
              : "SHELL_JOB_CLEANUP_BUSY",
        });
      } finally {
        releaseInspection();
      }
      expect((await recovering).accepted).toBe(true);
      expect(signalGroup).toHaveBeenCalledTimes(1);
      expect(store.get("job")).toMatchObject({
        status: "lost",
        cleanup: "confirmed",
        recoveryClaim: null,
      });
    },
  );

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
