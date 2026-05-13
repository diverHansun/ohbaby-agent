import { describe, expect, it } from "vitest";
import { Supervisor } from "./supervisor.js";
import type {
  DaemonLogger,
  DaemonPidFile,
  DaemonPidLock,
  DaemonRuntimeHandle,
  DaemonStateFile,
} from "./types.js";

const silentLogger: DaemonLogger = {
  info(): void {
    return undefined;
  },
  error(): void {
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

describe("Supervisor", () => {
  it("acquires process ownership, starts runtime, and releases ownership on stop", async () => {
    const calls: string[] = [];
    const supervisor = new Supervisor({
      pidFile: new RecordingPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "state.running",
      "runtime.start",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
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
      "state.running",
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
      "state.running",
      "runtime.start",
      "state.crashed:runtime failed",
      "runtime.stop",
      "pid.release",
      "pid.acquire",
      "state.running",
      "runtime.start",
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
      "state.running",
      "state.crashed:state running failed",
      "pid.release",
      "pid.acquire",
      "state.running",
      "runtime.start",
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
      "state.running",
      "runtime.start",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
      "pid.acquire",
      "state.running",
      "runtime.start",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
  });

  it("resets runtime state even when pid release fails during stop", async () => {
    const calls: string[] = [];
    const supervisor = new Supervisor({
      pidFile: new FirstReleaseFailsPidFile(calls),
      stateFile: new RecordingStateFile(calls),
      bootstrap: (): Promise<DaemonRuntimeHandle> =>
        Promise.resolve(new RecordingRuntime(calls)),
      logger: silentLogger,
      signalTarget: null,
      now: (): number => 1_000,
    });

    await supervisor.start();
    await expect(supervisor.stop()).rejects.toThrow("pid release failed");
    await supervisor.start();
    await supervisor.stop();

    expect(calls).toEqual([
      "pid.acquire",
      "state.running",
      "runtime.start",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
      "pid.acquire",
      "state.running",
      "runtime.start",
      "state.stopping",
      "runtime.stop",
      "state.stopped",
      "pid.release",
    ]);
  });
});
