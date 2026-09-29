import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { serverStopped, type Logger } from "ohbaby-agent";
import { Supervisor } from "./supervisor.js";
import type {
  DaemonPidFile,
  DaemonPidLock,
  DaemonState,
  DaemonRuntimeHandle,
  DaemonSignalTarget,
  DaemonStateFile,
} from "./types.js";

const silentLogger: Logger = {
  emit(): void {
    return undefined;
  },
};

class RecordingPidLock implements DaemonPidLock {
  constructor(private readonly calls: string[]) {}

  release(): Promise<void> {
    this.calls.push("pid.release");
    return Promise.resolve();
  }
}

class FailingReleasePidLock implements DaemonPidLock {
  constructor(private readonly calls: string[]) {}

  release(): Promise<void> {
    this.calls.push("pid.release");
    return Promise.reject(new Error("pid release failed"));
  }
}

class RecordingPidFile implements DaemonPidFile {
  constructor(private readonly calls: string[]) {}

  acquire(): Promise<DaemonPidLock> {
    this.calls.push("pid.acquire");
    return Promise.resolve(new RecordingPidLock(this.calls));
  }
}

class FirstReleaseFailsPidFile implements DaemonPidFile {
  private acquireCount = 0;

  constructor(private readonly calls: string[]) {}

  acquire(): Promise<DaemonPidLock> {
    this.acquireCount += 1;
    this.calls.push("pid.acquire");
    if (this.acquireCount === 1) {
      return Promise.resolve(new FailingReleasePidLock(this.calls));
    }

    return Promise.resolve(new RecordingPidLock(this.calls));
  }
}

class RecordingStateFile implements DaemonStateFile {
  constructor(private readonly calls: string[]) {}

  write(state: {
    readonly status: string;
    readonly error?: string;
  }): Promise<void> {
    const suffix = state.error ? `:${state.error}` : "";
    this.calls.push(`state.${state.status}${suffix}`);
    return Promise.resolve();
  }
}

class CapturingStateFile implements DaemonStateFile {
  readonly states: DaemonState[] = [];

  write(state: DaemonState): Promise<void> {
    this.states.push(state);
    return Promise.resolve();
  }
}

class FirstStatusWriteFailsStateFile implements DaemonStateFile {
  private failed = false;

  constructor(
    private readonly calls: string[],
    private readonly status: string,
    private readonly message: string,
  ) {}

  write(state: {
    readonly status: string;
    readonly error?: string;
  }): Promise<void> {
    const suffix = state.error ? `:${state.error}` : "";
    this.calls.push(`state.${state.status}${suffix}`);
    if (!this.failed && state.status === this.status) {
      this.failed = true;
      return Promise.reject(new Error(this.message));
    }

    return Promise.resolve();
  }
}

class RecordingRuntime implements DaemonRuntimeHandle {
  constructor(private readonly calls: string[]) {}

  start(): Promise<void> {
    this.calls.push("runtime.start");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push("runtime.stop");
    return Promise.resolve();
  }
}

class RecordingConnectionRuntime extends RecordingRuntime {
  readonly connection = {
    authToken: "token_1",
    host: "127.0.0.1",
    packageVersion: "0.1.0",
    port: 4096,
  };
}

class FailingRuntime extends RecordingRuntime {
  override start(): Promise<void> {
    return Promise.reject(new Error("runtime failed"));
  }
}

class StartFailingAndStopRejectingRuntime implements DaemonRuntimeHandle {
  constructor(private readonly calls: string[]) {}

  start(): Promise<void> {
    this.calls.push("runtime.start");
    return Promise.reject(new Error("runtime failed"));
  }

  stop(): Promise<void> {
    this.calls.push("runtime.stop");
    return Promise.reject(new Error("runtime cleanup failed"));
  }
}

class RecordingSignalTarget implements DaemonSignalTarget {
  private readonly listeners = new Map<NodeJS.Signals, () => void>();

  emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }

  off(signal: NodeJS.Signals, listener: () => void): void {
    if (this.listeners.get(signal) === listener) {
      this.listeners.delete(signal);
    }
  }

  on(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.set(signal, listener);
  }
}

describe("Supervisor", () => {
  it("stops after the idle timeout when the last client disconnects", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const supervisor = new Supervisor({
      bootstrap: (): DaemonRuntimeHandle => new RecordingRuntime(calls),
      idleTimeoutMs: 15 * 60 * 1000,
      logger: silentLogger,
      pidFile: new RecordingPidFile(calls),
      signalTarget: null,
      stateFile: new RecordingStateFile(calls),
    });

    try {
      await supervisor.start();
      supervisor.clientConnected("client_a");
      supervisor.clientDisconnected("client_a");
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(calls).toContain("runtime.stop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes running connection metadata after the runtime starts", async () => {
    const calls: string[] = [];
    const stateFile = new CapturingStateFile();
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile,
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingConnectionRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();

    expect(calls).toEqual(["pid.acquire", "runtime.start"]);
    expect(stateFile.states[0]).toEqual({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: process.pid,
      port: 4096,
      startedAt: 1_000,
      status: "running",
      updatedAt: 1_000,
    });

    await supervisor.stop();
  });

  it("acquires process ownership, starts runtime, and releases ownership on stop", async () => {
    const calls: string[] = [];
    const emit = vi.fn();
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: { emit },
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(serverStopped, { reason: "requested" });
  });

  it("marks the daemon crashed and cleans ownership when runtime start fails", async () => {
    const calls: string[] = [];
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new FailingRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await expect(supervisor.start()).rejects.toThrow("runtime failed");

    expect(calls).toEqual([
      "pid.acquire",
      "state.crashed:runtime failed",
      "runtime.stop",
      "pid.release",
    ]);
  });

  it("releases ownership and resets after runtime start and cleanup both fail", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? new StartFailingAndStopRejectingRuntime(calls)
            : new RecordingRuntime(calls),
        );
      },
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await expect(supervisor.start()).rejects.toThrow("runtime failed");
    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "runtime.start",
      "state.crashed:runtime failed",
      "runtime.stop",
      "pid.release",
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
  });

  it("releases ownership when writing the running state fails", async () => {
    const calls: string[] = [];
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new FirstStatusWriteFailsStateFile(
        calls,
        "running",
        "state running failed",
      ),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await expect(supervisor.start()).rejects.toThrow("state running failed");
    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.crashed:state running failed",
      "runtime.stop",
      "pid.release",
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
  });

  it("stops the runtime when writing the stopping state fails", async () => {
    const calls: string[] = [];
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new FirstStatusWriteFailsStateFile(
        calls,
        "stopping",
        "state stopping failed",
      ),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();
    await expect(supervisor.stop()).rejects.toThrow("state stopping failed");
    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
  });

  it("resets runtime state even when pid release fails during stop", async () => {
    const calls: string[] = [];
    const emit = vi.fn();
    const disposeDiagnostics = vi.fn(() =>
      Promise.reject(new Error("diagnostics dispose failed")),
    );
    const supervisor = new Supervisor({
      disposeDiagnostics,
      pidFile: new FirstReleaseFailsPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: { emit },
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();
    await expect(supervisor.stop()).rejects.toThrow("pid release failed");
    // The sink is already closed when PID release fails; the stop error/report
    // carries that failure rather than attempting a late diagnostic write.
    expect(emit).toHaveBeenCalledWith(serverStopped, {
      reason: "requested",
    });
    await supervisor.start();
    await supervisor.stop();
    expect(emit).toHaveBeenLastCalledWith(serverStopped, {
      reason: "requested",
    });

    expect(calls).toEqual([
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
      "pid.acquire",
      "runtime.start",
      "state.running",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
    expect(disposeDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("keeps successful stop and signal exit authoritative when diagnostics disposal fails", async () => {
    const calls: string[] = [];
    const disposeDiagnostics = vi.fn(() =>
      Promise.reject(new Error("diagnostics dispose failed")),
    );
    const emit = vi.fn();
    const exit = vi.fn();
    const signalTarget = new RecordingSignalTarget();
    const supervisor = new Supervisor({
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      disposeDiagnostics,
      exit,
      logger: { emit },
      pidFile: new RecordingPidFile(calls),
      signalTarget,
      stateFile: new RecordingStateFile(calls),
    });

    await supervisor.start();
    signalTarget.emit("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });

    expect(disposeDiagnostics).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(serverStopped, { reason: "signal" });
  });

  it("keeps concurrent stops joined until diagnostics disposal finishes", async () => {
    const calls: string[] = [];
    let finishDiagnostics: (() => void) | undefined;
    const disposeDiagnostics = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push("diagnostics.dispose");
          finishDiagnostics = resolve;
        }),
    );
    const supervisor = new Supervisor({
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      disposeDiagnostics,
      logger: silentLogger,
      pidFile: new RecordingPidFile(calls),
      signalTarget: null,
      stateFile: new RecordingStateFile(calls),
    });

    await supervisor.start();
    const firstStop = supervisor.stop();
    await vi.waitFor(() => {
      expect(disposeDiagnostics).toHaveBeenCalledTimes(1);
    });
    let secondSettled = false;
    const secondStop = supervisor.stop().finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(secondSettled).toBe(false);
    finishDiagnostics?.();
    await Promise.all([firstStop, secondStop]);
    expect(disposeDiagnostics).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe("pid.release");
  });
});

it("closes admission synchronously and bounds explicit stop including a hanging final save", async () => {
  const states: DaemonState[] = [];
  let closed = false;
  let stopCalls = 0;
  const supervisor = new Supervisor({
    pidFile: new RecordingPidFile([]),
    stateFile: {
      write(state): Promise<void> {
        states.push(state);
        return state.status === "stopped"
          ? new Promise<void>(() => undefined)
          : Promise.resolve();
      },
    },
    bootstrap: (): DaemonRuntimeHandle => ({
      start: (): Promise<void> => Promise.resolve(),
      closeAdmission: (): void => {
        closed = true;
      },
      stop: (): Promise<void> => {
        stopCalls++;
        return Promise.resolve();
      },
    }),
    signalTarget: null,
    shutdownTimeoutMs: 40,
  });
  await supervisor.start();
  const start = Date.now();
  const first = supervisor.stop();
  expect(closed).toBe(true);
  const second = supervisor.stop();
  await expect(first).rejects.toThrow(/deadline|timed out/i);
  await expect(second).rejects.toThrow(/deadline|timed out/i);
  expect(Date.now() - start).toBeLessThan(180);
  expect(stopCalls).toBe(1);
});

it("keeps the PID lock until diagnostics have closed and includes release failure in the final report", async () => {
  const order: string[] = [];
  let finishDiagnostics: (() => void) | undefined;
  const reports: import("./types.js").DaemonShutdownReport[] = [];
  const release = vi.fn(() => {
    order.push("release");
    return Promise.reject(new Error("unlink unavailable"));
  });
  const disposeDiagnostics = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishDiagnostics = (): void => {
          order.push("diagnostics");
          resolve();
        };
      }),
  );
  const supervisor = new Supervisor({
    pidFile: {
      acquire: (): Promise<DaemonPidLock> =>
        Promise.resolve({
          record: { pid: process.pid, token: "original", startedAt: 1 },
          release,
        }),
    },
    stateFile: {
      write: (): Promise<void> => Promise.resolve(),
      writeShutdownReport: (report): Promise<void> => {
        order.push("report");
        reports.push(report);
        return Promise.resolve();
      },
    },
    bootstrap: (): DaemonRuntimeHandle => new RecordingRuntime([]),
    disposeDiagnostics,
    signalTarget: null,
  });
  await supervisor.start();
  const stopped = supervisor.stop();
  const rejected = expect(stopped).rejects.toThrow("unlink unavailable");
  try {
    await vi.waitFor(() => {
      expect(disposeDiagnostics).toHaveBeenCalledOnce();
    });
    expect(release).not.toHaveBeenCalled();
  } finally {
    finishDiagnostics?.();
    await rejected;
  }
  expect(order).toEqual(["diagnostics", "release", "report"]);
  expect(reports).toHaveLength(1);
  expect(reports[0]?.cleanup).toEqual({
    status: "unconfirmed",
    errors: ["pid.release: unlink unavailable"],
  });
});

it("treats a returned unconfirmed cleanup result as shutdown failure", async () => {
  const supervisor = new Supervisor({
    pidFile: new RecordingPidFile([]),
    stateFile: new CapturingStateFile(),
    bootstrap: (): DaemonRuntimeHandle => ({
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<import("ohbaby-agent").CleanupResult> =>
        Promise.resolve({
          status: "unconfirmed" as const,
          errors: ["tool still active"],
        }),
    }),
    signalTarget: null,
  });
  await supervisor.start();
  await expect(supervisor.stop()).rejects.toThrow("tool still active");
});

it("records the final stop diagnostic before disposing its logger", async () => {
  let loggerClosed = false;
  const recorded: unknown[] = [];
  const supervisor = new Supervisor({
    pidFile: new RecordingPidFile([]),
    stateFile: new CapturingStateFile(),
    bootstrap: (): DaemonRuntimeHandle => ({
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }),
    signalTarget: null,
    logger: {
      emit(definition): void {
        if (!loggerClosed) recorded.push(definition);
      },
    },
    disposeDiagnostics: (): Promise<void> => {
      loggerClosed = true;
      return Promise.resolve();
    },
  });
  await supervisor.start();
  await supervisor.stop();
  expect(recorded).toContain(serverStopped);
});
