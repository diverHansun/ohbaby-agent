import { describe, expect, it } from "vitest";
import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleRunParams,
} from "../../core/lifecycle/index.js";
import {
  createInMemoryRunLedger,
  type MarkInterruptedOptions,
  type MarkInterruptedResult,
  type RunLedger,
  type RunLedgerRecord,
} from "../run-ledger/index.js";
import type {
  StreamBridge,
  StreamBridgeYield,
  StreamScope,
} from "../stream-bridge/index.js";
import {
  ConcurrencyRejectedError,
  RunManager,
  RunManagerNotFoundError,
  type HookExecutor,
  type PermissionProfile,
  type RunDefaultsPolicy,
  type RunLifecycle,
  type SandboxLease,
  type SandboxManager,
} from "./index.js";

const policy: RunDefaultsPolicy = {
  defaults: {
    user: {
      permissionProfileId: "interactive",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    scheduler: {
      permissionProfileId: "read-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    heartbeat: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    channel: {
      permissionProfileId: "notify-only",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
    "follow-up": {
      permissionProfileId: "full-auto",
      multitaskStrategy: "reject",
      disconnectMode: "continue",
    },
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createClock(startAt = 1_000): () => number {
  let current = startAt;

  return () => {
    const value = current;
    current += 1_000;
    return value;
  };
}

class RecordingLedger implements RunLedger {
  readonly calls: string[] = [];
  private readonly inner: RunLedger;

  constructor(now: () => number) {
    this.inner = createInMemoryRunLedger({ now });
  }

  createPending(
    input: Parameters<RunLedger["createPending"]>[0],
  ): Promise<RunLedgerRecord> {
    this.calls.push("createPending");
    return this.inner.createPending(input);
  }

  markRunning(runId: string): Promise<RunLedgerRecord> {
    this.calls.push("markRunning");
    return this.inner.markRunning(runId);
  }

  markSucceeded(runId: string): Promise<RunLedgerRecord> {
    this.calls.push("markSucceeded");
    return this.inner.markSucceeded(runId);
  }

  markFailed(runId: string, error: unknown): Promise<RunLedgerRecord> {
    this.calls.push("markFailed");
    return this.inner.markFailed(runId, error);
  }

  markCancelled(runId: string, reason?: string): Promise<RunLedgerRecord> {
    this.calls.push("markCancelled");
    return this.inner.markCancelled(runId, reason);
  }

  markInterrupted(
    options?: MarkInterruptedOptions,
  ): Promise<MarkInterruptedResult> {
    this.calls.push("markInterrupted");
    return this.inner.markInterrupted(options);
  }

  get(runId: string): Promise<RunLedgerRecord | undefined> {
    return this.inner.get(runId);
  }

  listBySession(
    sessionId: string,
    options?: Parameters<RunLedger["listBySession"]>[1],
  ): Promise<RunLedgerRecord[]> {
    return this.inner.listBySession(sessionId, options);
  }

  getActiveRuns(sessionId?: string): Promise<RunLedgerRecord[]> {
    return this.inner.getActiveRuns(sessionId);
  }
}

class RecordingBridge implements StreamBridge {
  readonly events: {
    readonly scope: StreamScope;
    readonly event: string;
    readonly data: unknown;
  }[] = [];
  readonly endedScopes: StreamScope[] = [];

  publish(scope: StreamScope, event: string, data: unknown): number {
    this.events.push({ scope, event, data });
    return this.events.length;
  }

  subscribe(): AsyncIterable<StreamBridgeYield> {
    throw new Error("subscribe is not used in run-manager tests");
  }

  end(scope: StreamScope): void {
    this.endedScopes.push(scope);
  }
}

class FailingOnceBridge extends RecordingBridge {
  private remainingFailures = 1;

  override publish(scope: StreamScope, event: string, data: unknown): number {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("stream publish failed");
    }

    return super.publish(scope, event, data);
  }
}

class RecordingHooks implements HookExecutor {
  readonly calls: string[] = [];

  execute(point: "pre-run" | "post-run"): Promise<void> {
    this.calls.push(point);
    return Promise.resolve();
  }
}

class RecordingSandboxManager implements SandboxManager {
  readonly released: string[] = [];

  acquire(sessionId: string): Promise<SandboxLease> {
    return Promise.resolve({
      id: `lease_${sessionId}`,
      workdir: `workspace/${sessionId}`,
    });
  }

  release(lease: SandboxLease): Promise<void> {
    this.released.push(lease.id ?? "unknown");
    return Promise.resolve();
  }
}

class RejectingReleaseSandboxManager extends RecordingSandboxManager {
  override release(lease: SandboxLease): Promise<void> {
    this.released.push(lease.id ?? "unknown");
    return Promise.reject(new Error("release failed"));
  }
}

class CompletingLifecycle implements RunLifecycle {
  readonly calls: LifecycleRunParams[] = [];

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    this.calls.push(params);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: 10,
    };
    yield {
      type: "llm:delta",
      sessionId: params.sessionId,
      timestamp: 20,
      delta: "Hello",
      content: "Hello",
      completeMessage: { role: "assistant", content: "Hello" },
    };
    yield {
      type: "llm:complete",
      sessionId: params.sessionId,
      timestamp: 30,
      finishReason: "stop",
      completeMessage: { role: "assistant", content: "Hello" },
    };

    return {
      success: true,
      finishReason: "stop",
      finalResponse: "Hello",
    };
  }
}

class BlockingLifecycle implements RunLifecycle {
  readonly started = createDeferred<AbortSignal | undefined>();
  readonly finish = createDeferred<undefined>();

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.started.resolve(params.signal);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: 10,
    };
    await this.finish.promise;

    return {
      success: true,
      finishReason: "stop",
      finalResponse: "",
    };
  }
}

class AbortAwareLifecycle implements RunLifecycle {
  readonly started = createDeferred<AbortSignal | undefined>();

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.started.resolve(params.signal);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: 10,
    };
    if (params.signal?.aborted) {
      return {
        success: false,
        finishReason: "error",
        finalResponse: "",
      };
    }
    await new Promise<void>((resolve) => {
      params.signal?.addEventListener(
        "abort",
        () => {
          resolve();
        },
        {
          once: true,
        },
      );
    });

    return {
      success: false,
      finishReason: "error",
      finalResponse: "",
    };
  }
}

class InterruptThenCompleteLifecycle implements RunLifecycle {
  readonly firstStarted = createDeferred<AbortSignal | undefined>();
  private callCount = 0;

  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.callCount += 1;
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: 10,
    };

    if (this.callCount === 1) {
      this.firstStarted.resolve(params.signal);
      if (!params.signal?.aborted) {
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }

      return {
        success: false,
        finishReason: "error",
        finalResponse: "",
      };
    }

    yield {
      type: "llm:complete",
      sessionId: params.sessionId,
      timestamp: 20,
      finishReason: "stop",
      completeMessage: { role: "assistant", content: "replacement" },
    };

    return {
      success: true,
      finishReason: "stop",
      finalResponse: "replacement",
    };
  }
}

class ThrowingLifecycle implements RunLifecycle {
  async *run(
    params: LifecycleRunParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      timestamp: 10,
    };
    throw new Error("lifecycle exploded");
  }
}

interface ManagerFixture {
  readonly manager: RunManager;
  readonly ledger: RecordingLedger;
  readonly bridge: RecordingBridge;
  readonly hooks: RecordingHooks;
  readonly sandboxManager: RecordingSandboxManager;
}

function createManager(lifecycle: RunLifecycle): ManagerFixture {
  const now = createClock();
  const ledger = new RecordingLedger(now);
  const bridge = new RecordingBridge();
  const hooks = new RecordingHooks();
  const sandboxManager = new RecordingSandboxManager();
  let nextRunId = 1;
  const manager = new RunManager({
    lifecycle,
    runLedger: ledger,
    streamBridge: bridge,
    hookExecutor: hooks,
    sandboxManager,
    profileRegistry: {
      getProfile(id: string): PermissionProfile {
        return { id };
      },
    },
    policy,
    now,
    createRunId(): string {
      const id = `run_${String(nextRunId)}`;
      nextRunId += 1;
      return id;
    },
  });

  return { manager, ledger, bridge, hooks, sandboxManager };
}

function createManagerWithOverrides(input: {
  readonly lifecycle: RunLifecycle;
  readonly bridge?: StreamBridge;
  readonly sandboxManager?: SandboxManager;
}): ManagerFixture {
  const fixture = createManager(input.lifecycle);
  const manager = new RunManager({
    lifecycle: input.lifecycle,
    runLedger: fixture.ledger,
    streamBridge: input.bridge ?? fixture.bridge,
    hookExecutor: fixture.hooks,
    sandboxManager: input.sandboxManager ?? fixture.sandboxManager,
    profileRegistry: {
      getProfile(id: string): PermissionProfile {
        return { id };
      },
    },
    policy,
    now: createClock(10_000),
    createRunId(): string {
      return "run_override";
    },
  });

  return {
    ...fixture,
    manager,
    bridge:
      input.bridge instanceof RecordingBridge ? input.bridge : fixture.bridge,
    sandboxManager:
      input.sandboxManager instanceof RecordingSandboxManager
        ? input.sandboxManager
        : fixture.sandboxManager,
  };
}

describe("RunManager", () => {
  it("starts a run, streams lifecycle events, and records success", async () => {
    const lifecycle = new CompletingLifecycle();
    const { manager, ledger, bridge, hooks, sandboxManager } =
      createManager(lifecycle);

    const record = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "Say hello" }],
    });
    const completion = await manager.waitForCompletion(record.runId);

    expect(completion.status).toBe("succeeded");
    const ledgerRecord = await ledger.get(record.runId);
    expect(ledgerRecord?.status).toBe("succeeded");
    expect(typeof ledgerRecord?.startedAt).toBe("number");
    expect(typeof ledgerRecord?.endedAt).toBe("number");
    expect(ledger.calls).toEqual([
      "createPending",
      "markRunning",
      "markSucceeded",
    ]);
    expect(hooks.calls).toEqual(["pre-run", "post-run"]);
    expect(lifecycle.calls[0]).toMatchObject({
      sessionId: "session_1",
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(bridge.events.map((event) => event.event)).toEqual([
      "run.updated",
      "run.updated",
      "message.part.delta",
      "run.llm.complete",
      "run.updated",
    ]);
    expect(bridge.endedScopes).toEqual(["run/run_1"]);
    expect(sandboxManager.released).toEqual(["lease_session_1"]);
    expect(manager.list("session_1")).toEqual([]);
  });

  it("rejects concurrent creates for the same session without blocking other sessions", async () => {
    const lifecycle = new BlockingLifecycle();
    const { manager } = createManager(lifecycle);

    const first = manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "one" }],
    });
    await lifecycle.started.promise;

    await expect(
      manager.create({
        sessionId: "session_1",
        triggerSource: "user",
        messages: [{ role: "user", content: "two" }],
      }),
    ).rejects.toBeInstanceOf(ConcurrencyRejectedError);

    await expect(
      manager.create({
        sessionId: "session_2",
        triggerSource: "user",
        messages: [{ role: "user", content: "other" }],
      }),
    ).resolves.toMatchObject({ sessionId: "session_2" });

    lifecycle.finish.resolve(undefined);
    await expect(first).resolves.toMatchObject({ runId: "run_1" });
    await manager.cancelAll();
  });

  it("propagates cancel through AbortSignal and marks the run cancelled", async () => {
    const lifecycle = new AbortAwareLifecycle();
    const { manager, ledger, bridge } = createManager(lifecycle);
    const record = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "stop" }],
    });
    const signal = await lifecycle.started.promise;

    manager.cancel(record.runId, "user requested stop");

    expect(signal?.aborted).toBe(true);
    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "cancelled",
      error: "user requested stop",
    });
    await expect(ledger.get(record.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: "user requested stop",
    });
    expect(bridge.endedScopes).toEqual(["run/run_1"]);
  });

  it("resolves completion and closes the stream when sandbox release fails", async () => {
    const sandboxManager = new RejectingReleaseSandboxManager();
    const { manager, bridge } = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      sandboxManager,
    });

    const record = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "release" }],
    });

    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });
    expect(sandboxManager.released).toEqual(["lease_session_1"]);
    expect(bridge.endedScopes).toEqual(["run/run_override"]);
  });

  it("does not orphan active runs when initial stream publish fails", async () => {
    const bridge = new FailingOnceBridge();
    const { manager, ledger } = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      bridge,
    });

    const record = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "publish failure" }],
    });

    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });
    await expect(ledger.get(record.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(manager.list("session_1")).toEqual([]);
  });

  it("interrupts the current run before starting a replacement when requested", async () => {
    const lifecycle = new InterruptThenCompleteLifecycle();
    const { manager } = createManager(lifecycle);

    const first = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "first" }],
    });
    const firstSignal = await lifecycle.firstStarted.promise;

    const second = await manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      explicit: { multitaskStrategy: "interrupt-current" },
      messages: [{ role: "user", content: "second" }],
    });

    expect(firstSignal?.aborted).toBe(true);
    await expect(manager.waitForCompletion(first.runId)).resolves.toEqual({
      status: "cancelled",
      error: "interrupted by replacement run",
    });
    await expect(manager.waitForCompletion(second.runId)).resolves.toEqual({
      status: "succeeded",
    });
  });

  it("isolates lifecycle failures and allows later runs in the same session", async () => {
    const failing = createManager(new ThrowingLifecycle());
    const failed = await failing.manager.create({
      sessionId: "session_1",
      triggerSource: "user",
      messages: [{ role: "user", content: "boom" }],
    });

    await expect(
      failing.manager.waitForCompletion(failed.runId),
    ).resolves.toEqual({
      status: "failed",
      error: "lifecycle exploded",
    });
    expect(failing.manager.list("session_1")).toEqual([]);

    const succeeding = new CompletingLifecycle();
    const manager = new RunManager({
      lifecycle: succeeding,
      runLedger: failing.ledger,
      streamBridge: failing.bridge,
      hookExecutor: failing.hooks,
      sandboxManager: failing.sandboxManager,
      profileRegistry: {
        getProfile(id: string): PermissionProfile {
          return { id };
        },
      },
      policy,
      now: createClock(20_000),
      createRunId: (): string => "run_after_failure",
    });

    await expect(
      manager.create({
        sessionId: "session_1",
        triggerSource: "user",
        messages: [{ role: "user", content: "after" }],
      }),
    ).resolves.toMatchObject({ runId: "run_after_failure" });
  });

  it("marks prior pending and running ledger records interrupted during init", async () => {
    const { manager, ledger } = createManager(new CompletingLifecycle());
    await ledger.createPending({
      runId: "pending_run",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await ledger.createPending({
      runId: "running_run",
      sessionId: "session_2",
      triggerSource: "scheduler",
    });
    await ledger.markRunning("running_run");

    await expect(manager.init()).resolves.toEqual({ updatedCount: 2 });
    await expect(manager.init()).resolves.toEqual({ updatedCount: 0 });
    await expect(ledger.get("pending_run")).resolves.toMatchObject({
      status: "interrupted",
    });
    await expect(ledger.get("running_run")).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  it("throws when cancelling an unknown run", () => {
    const { manager } = createManager(new CompletingLifecycle());

    expect(() => {
      manager.cancel("missing_run");
    }).toThrow(RunManagerNotFoundError);
  });
});
