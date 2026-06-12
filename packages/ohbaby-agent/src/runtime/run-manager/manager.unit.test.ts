import { describe, expect, it } from "vitest";
import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "../../core/lifecycle/index.js";
import type { ToolCallResult } from "../../core/tool-scheduler/index.js";
import type { PreflightResult } from "../../sandbox/index.js";
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
import { SnapshotHookExecutionError } from "../../snapshot/index.js";
import {
  ConcurrencyRejectedError,
  RunManager,
  RunManagerNotFoundError,
  type HookExecutor,
  type RunDefaultsPolicy,
  type RunHookContext,
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
  },
};

function emptyPreflight(): PreflightResult {
  return {
    commands: [],
    denylistHits: [],
    externalPaths: [],
    internalPaths: [],
    overallDanger: "readonly",
    sensitivePaths: [],
    shellKind: "bash",
  };
}

function createTestSandboxLease(sessionId: string): SandboxLease {
  const workdir = `workspace/${sessionId}`;

  return {
    adapterId: "host-local",
    capabilities: {
      canExecCommands: true,
      isolation: "none",
      readOnly: false,
      supportsGit: false,
    },
    containsTrustedPath: () => true,
    contextId: `context_${sessionId}`,
    leaseId: `lease_${sessionId}`,
    preflight: () => Promise.resolve(emptyPreflight()),
    release: () => Promise.resolve(),
    resolveCommandContext: () => ({ cwd: workdir, kind: "host-local" }),
    resolvePath: (inputPath: string) => `${workdir}/${inputPath}`,
    resolvePathForExisting: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    resolvePathForWrite: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    sessionId,
    trustPath: (input) =>
      Promise.resolve({ kind: input.kind, path: input.path }),
    trustedRoots: () => [{ kind: "workspace", path: workdir }],
    workdir,
  };
}

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

  claimPendingRun(
    input: Parameters<RunLedger["claimPendingRun"]>[0],
  ): Promise<RunLedgerRecord> {
    this.calls.push("claimPendingRun");
    return this.inner.claimPendingRun(input);
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
  readonly contexts: RunHookContext[] = [];

  execute(
    point: "pre-run" | "post-run",
    context: RunHookContext,
  ): Promise<void> {
    this.calls.push(point);
    this.contexts.push(context);
    return Promise.resolve();
  }
}

class ConditionalThrowingHooks implements HookExecutor {
  constructor(private readonly error: Error) {}

  execute(
    point: "pre-run" | "post-run",
    _context: RunHookContext,
  ): Promise<void> {
    if (point === "pre-run") {
      return Promise.reject(this.error);
    }
    return Promise.resolve();
  }
}

class RecordingSandboxManager implements SandboxManager {
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  acquire(sessionId: string): Promise<SandboxLease> {
    this.acquired.push(sessionId);
    return Promise.resolve(createTestSandboxLease(sessionId));
  }

  release(lease: SandboxLease): Promise<void> {
    this.released.push(lease.leaseId);
    return Promise.resolve();
  }
}

class RejectingReleaseSandboxManager extends RecordingSandboxManager {
  override release(lease: SandboxLease): Promise<void> {
    this.released.push(lease.leaseId);
    return Promise.reject(new Error("release failed"));
  }
}

class CompletingLifecycle implements RunLifecycle {
  readonly calls: LifecycleSessionParams[] = [];

  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    this.calls.push(params);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 10,
    };
    yield {
      type: "llm:delta",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 20,
      delta: "Hello",
      content: "Hello",
      completeMessage: { role: "assistant", content: "Hello" },
    };
    yield {
      type: "llm:complete",
      sessionId: params.sessionId,
      step: 1,
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

class FailedResultLifecycle implements RunLifecycle {
  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 10,
    };

    return {
      success: false,
      finishReason: "error",
      finalResponse: "Context overflow after forced compaction retry",
      terminalReason: "context_overflow",
    };
  }
}

class SessionLifecycle implements RunLifecycle {
  readonly calls: LifecycleSessionParams[] = [];

  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    this.calls.push(params);
    yield {
      compaction: undefined,
      hasSummary: false,
      sessionId: params.sessionId,
      step: 1,
      timestamp: 5,
      type: "turn:start",
      usage: {
        contextLimit: 128,
        currentTokens: 10,
        modelId: params.modelId,
        remainingTokens: 118,
        shouldCompress: false,
        usageRatio: 0.08,
      },
    };
    yield {
      compaction: {
        status: "compacted",
        usageAfter: {
          contextLimit: 128,
          currentTokens: 12,
          modelId: params.modelId,
          remainingTokens: 116,
          shouldCompress: false,
          usageRatio: 0.09,
        },
        usageBefore: {
          contextLimit: 128,
          currentTokens: 120,
          modelId: params.modelId,
          remainingTokens: 8,
          shouldCompress: true,
          usageRatio: 0.94,
        },
      },
      hasSummary: true,
      sessionId: params.sessionId,
      step: 1,
      timestamp: 6,
      type: "context:prepared",
      usage: {
        contextLimit: 128,
        currentTokens: 12,
        modelId: params.modelId,
        remainingTokens: 116,
        shouldCompress: false,
        usageRatio: 0.09,
      },
    };
    yield {
      completeMessage: { role: "assistant", content: "Hello" },
      content: "Hello",
      delta: "Hello",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 20,
      type: "llm:delta",
    };
    yield {
      finishReason: "stop",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 30,
      type: "turn:end",
      usage: {
        contextLimit: 128,
        currentTokens: 10,
        modelId: params.modelId,
        remainingTokens: 118,
        shouldCompress: false,
        usageRatio: 0.08,
      },
    };

    return {
      finalResponse: "Hello",
      finishReason: "stop",
      success: true,
    };
  }
}

class BlockingLifecycle implements RunLifecycle {
  readonly started = createDeferred<AbortSignal | undefined>();
  readonly finish = createDeferred<undefined>();

  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.started.resolve(params.signal);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
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
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.started.resolve(params.signal);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
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
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    this.callCount += 1;
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
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
      step: 1,
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
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 10,
    };
    throw new Error("lifecycle exploded");
  }
}

class ToolEventLifecycle implements RunLifecycle {
  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    const result: ToolCallResult = {
      callId: "call_1",
      output: "weather: sunny",
      status: "success",
    };

    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 10,
    };
    yield {
      type: "tool:start",
      callId: "call_1",
      params: { location: "NYC" },
      sessionId: params.sessionId,
      step: 1,
      timestamp: 20,
      toolName: "get_weather",
    };
    yield {
      type: "tool:result",
      callId: "call_1",
      result,
      sessionId: params.sessionId,
      step: 1,
      timestamp: 30,
      toolName: "get_weather",
      params: { location: "NYC" },
    };

    return {
      finalResponse: "done",
      finishReason: "stop",
      success: true,
    };
  }
}

class RetryingLifecycle implements RunLifecycle {
  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    await Promise.resolve();
    yield {
      type: "llm:retrying",
      attempt: 2,
      delayMs: 1250,
      maxRetries: 5,
      reason: "server_error",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 25,
    };

    return {
      finalResponse: "done",
      finishReason: "stop",
      success: true,
    };
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
  readonly hookExecutor?: HookExecutor;
  readonly sandboxManager?: SandboxManager;
}): ManagerFixture {
  const fixture = createManager(input.lifecycle);
  const manager = new RunManager({
    lifecycle: input.lifecycle,
    runLedger: fixture.ledger,
    streamBridge: input.bridge ?? fixture.bridge,
    hookExecutor: input.hookExecutor ?? fixture.hooks,
    sandboxManager: input.sandboxManager ?? fixture.sandboxManager,
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
  it("starts a session run without preassembled messages", async () => {
    const lifecycle = new SessionLifecycle();
    const { manager, bridge } = createManager(lifecycle);

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      runId: "run_explicit",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });

    expect(record.runId).toBe("run_explicit");
    expect(lifecycle.calls[0]).toMatchObject({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
    });
    expect(lifecycle.calls[0]).not.toHaveProperty("permissionProfileId");
    expect(bridge.events.map((event) => event.event)).toEqual([
      "run.updated",
      "run.updated",
      "run.turn.start",
      "run.context.prepared",
      "message.part.delta",
      "run.turn.end",
      "run.updated",
    ]);
    expect(
      bridge.events.find((event) => event.event === "run.context.prepared")
        ?.data,
    ).toMatchObject({
      compaction: {
        status: "compacted",
      },
      hasSummary: true,
      sessionId: "session_1",
      step: 1,
      usage: {
        currentTokens: 12,
      },
    });
  });

  it("starts a run, streams lifecycle events, and records success", async () => {
    const lifecycle = new CompletingLifecycle();
    const { manager, ledger, bridge, hooks, sandboxManager } =
      createManager(lifecycle);

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    const completion = await manager.waitForCompletion(record.runId);

    expect(completion.status).toBe("succeeded");
    const ledgerRecord = await ledger.get(record.runId);
    expect(ledgerRecord?.status).toBe("succeeded");
    expect(typeof ledgerRecord?.startedAt).toBe("number");
    expect(typeof ledgerRecord?.endedAt).toBe("number");
    expect(ledger.calls).toEqual([
      "claimPendingRun",
      "markRunning",
      "markSucceeded",
    ]);
    expect(hooks.calls).toEqual(["pre-run", "post-run"]);
    expect(lifecycle.calls[0]).toMatchObject({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      environment: {
        workdir: "workspace/session_1",
      },
    });
    expect(typeof lifecycle.calls[0]?.environment?.preflight).toBe("function");
    expect(lifecycle.calls[0]).not.toHaveProperty("permissionProfileId");
    expect(hooks.contexts[0]?.permissionProfileId).toBe("interactive");
    expect(bridge.events.map((event) => event.event)).toEqual([
      "run.updated",
      "run.updated",
      "run.llm.start",
      "message.part.delta",
      "run.llm.complete",
      "run.updated",
    ]);
    expect(bridge.events.find((event) => event.event === "run.llm.start"))
      .toMatchObject({
        data: {
          runId: "run_1",
          sessionId: "session_1",
          step: 1,
        },
        event: "run.llm.start",
        scope: "run/run_1",
      });
    expect(bridge.endedScopes).toEqual(["run/run_1"]);
    expect(sandboxManager.released).toEqual(["lease_session_1"]);
    expect(manager.list("session_1")).toEqual([]);
  });

  it("forwards maxSteps to the lifecycle", async () => {
    const lifecycle = new CompletingLifecycle();
    const { manager } = createManager(lifecycle);

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      maxSteps: 3,
      sessionId: "session_1",
      triggerSource: "user",
    });
    await manager.waitForCompletion(record.runId);

    expect(lifecycle.calls[0]).toMatchObject({
      maxSteps: 3,
      sessionId: "session_1",
    });
  });

  it("publishes lifecycle tool events to the run stream", async () => {
    const { manager, bridge } = createManager(new ToolEventLifecycle());

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });

    const toolStart = bridge.events.find(
      (event) => event.event === "run.tool.start",
    );
    const toolResult = bridge.events.find(
      (event) => event.event === "run.tool.result",
    );
    expect(toolStart).toMatchObject({
      event: "run.tool.start",
      scope: "run/run_1",
      data: {
        callId: "call_1",
        params: { location: "NYC" },
        runId: "run_1",
        sessionId: "session_1",
        status: "executing",
        step: 1,
        toolName: "get_weather",
      },
    });
    expect(toolResult).toMatchObject({
      event: "run.tool.result",
      scope: "run/run_1",
      data: {
        callId: "call_1",
        result: {
          callId: "call_1",
          output: "weather: sunny",
          status: "success",
        },
        params: { location: "NYC" },
        runId: "run_1",
        sessionId: "session_1",
        status: "success",
        step: 1,
        toolName: "get_weather",
      },
    });
  });

  it("publishes lifecycle retry events to the run stream", async () => {
    const { manager, bridge } = createManager(new RetryingLifecycle());

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });

    expect(
      bridge.events.find((event) => event.event === "run.llm.retrying"),
    ).toMatchObject({
      event: "run.llm.retrying",
      scope: "run/run_1",
      data: {
        attempt: 2,
        delayMs: 1250,
        maxRetries: 5,
        reason: "server_error",
        runId: "run_1",
        sessionId: "session_1",
        step: 1,
      },
    });
  });

  it("rejects concurrent creates for the same session without blocking other sessions", async () => {
    const lifecycle = new BlockingLifecycle();
    const { manager } = createManager(lifecycle);

    const first = manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await lifecycle.started.promise;

    await expect(
      manager.create({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(ConcurrencyRejectedError);

    await expect(
      manager.create({
        directory: "D:/other",
        modelId: "fake-model",
        sessionId: "session_2",
        triggerSource: "user",
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
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
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
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
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
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
    });
    await expect(ledger.get(record.runId)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(manager.list("session_1")).toEqual([]);
  });

  it("publishes snapshot hook failures without mislabeling ordinary hook failures", async () => {
    const snapshotBridge = new RecordingBridge();
    const snapshotFailure = new SnapshotHookExecutionError(
      "pre-run",
      new Error("git missing"),
    );
    const snapshotFixture = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      bridge: snapshotBridge,
      hookExecutor: new ConditionalThrowingHooks(snapshotFailure),
    });

    const snapshotRecord = await snapshotFixture.manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_snapshot",
      triggerSource: "user",
    });
    await snapshotFixture.manager.waitForCompletion(snapshotRecord.runId);

    const snapshotHookEvents = snapshotBridge.events.filter(
      (event) => event.event === "snapshot.hook.failed",
    );
    expect(snapshotHookEvents).toHaveLength(1);
    expect(snapshotHookEvents[0]?.scope).toBe("run/run_override");
    expect(snapshotHookEvents[0]?.data).toMatchObject({
      error: "git missing",
      point: "pre-run",
    });

    const ordinaryBridge = new RecordingBridge();
    const ordinaryFixture = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      bridge: ordinaryBridge,
      hookExecutor: new ConditionalThrowingHooks(
        new Error("ordinary hook failed"),
      ),
    });

    const ordinaryRecord = await ordinaryFixture.manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_ordinary",
      triggerSource: "user",
    });
    await ordinaryFixture.manager.waitForCompletion(ordinaryRecord.runId);

    expect(
      ordinaryBridge.events.filter(
        (event) => event.event === "snapshot.hook.failed",
      ),
    ).toEqual([]);
  });

  it("interrupts the current run before starting a replacement when requested", async () => {
    const lifecycle = new InterruptThenCompleteLifecycle();
    const { manager } = createManager(lifecycle);

    const first = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    const firstSignal = await lifecycle.firstStarted.promise;

    const second = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
      explicit: { multitaskStrategy: "interrupt-current" },
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
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
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
      policy,
      now: createClock(20_000),
      createRunId: (): string => "run_after_failure",
    });

    await expect(
      manager.create({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).resolves.toMatchObject({ runId: "run_after_failure" });
  });

  it("preserves lifecycle failure reasons in run completion", async () => {
    const { manager, bridge } = createManager(new FailedResultLifecycle());
    const failed = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(manager.waitForCompletion(failed.runId)).resolves.toEqual({
      status: "failed",
      error: "Context overflow after forced compaction retry",
      terminalReason: "context_overflow",
    });
    expect(
      bridge.events
        .filter((event) => event.event === "run.updated")
        .at(-1)?.data,
    ).toMatchObject({
      run: {
        runId: failed.runId,
        status: "failed",
        terminalReason: "context_overflow",
      },
    });
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
      triggerSource: "user",
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
