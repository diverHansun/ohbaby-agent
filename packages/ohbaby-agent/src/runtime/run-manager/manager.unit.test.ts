import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionManager } from "../../permission/index.js";
import type { SchedulerPermissionResponse } from "../../permission/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "../../core/lifecycle/index.js";
import type { ToolCallResult } from "../../core/tool-scheduler/index.js";
import type { PreflightResult } from "../../sandbox/index.js";
import {
  createInMemoryRunLedger,
  SessionRunBusyError,
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
import { NodeSqliteConnection } from "../../services/database/connection.js";
import { runWriteTransaction } from "../../services/database/index.js";
import {
  createDatabaseWriteBudget,
  getDatabaseWriteBudget,
  withDatabaseWriteBudget,
} from "../../services/database/write-budget.js";
import {
  ConcurrencyRejectedError,
  RunManager,
  RunManagerNotFoundError,
  type HookExecutor,
  type RunDefaultsPolicy,
  type RunHookContext,
  type RunLifecycle,
  type RunStepUsageObserver,
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

type RecordingSandboxAcquireInput =
  | string
  | {
      readonly contextScopeId?: string;
      readonly sessionId: string;
      readonly workdir?: string;
    };

function sandboxInputSessionId(input: RecordingSandboxAcquireInput): string {
  return typeof input === "string" ? input : input.sessionId;
}

function sandboxInputScopeKey(input: RecordingSandboxAcquireInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input.contextScopeId === undefined
    ? input.sessionId
    : `${input.sessionId}::${input.contextScopeId}`;
}

function createTestSandboxLease(
  input: RecordingSandboxAcquireInput,
): SandboxLease {
  const sessionId = sandboxInputSessionId(input);
  const scopeKey = sandboxInputScopeKey(input);
  const workdir = `workspace/${scopeKey}`;

  return {
    adapterId: "host-local",
    capabilities: {
      canExecCommands: true,
      isolation: "none",
      readOnly: false,
      supportsGit: false,
    },
    containsTrustedPath: () => true,
    contextId: `context_${scopeKey}`,
    contextScopeId:
      typeof input === "string" ? undefined : input.contextScopeId,
    leaseId: `lease_${scopeKey}`,
    preflight: () => Promise.resolve(emptyPreflight()),
    release: () => Promise.resolve(),
    resolveCommandContext: () => ({ cwd: workdir, kind: "host-local" }),
    resolvePath: (inputPath: string) => `${workdir}/${inputPath}`,
    resolvePathForExisting: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    resolvePathForWrite: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    sessionId,
    scopeKey,
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

  markSucceeded(
    runId: string,
    options?: Parameters<RunLedger["markSucceeded"]>[1],
  ): Promise<RunLedgerRecord> {
    this.calls.push("markSucceeded");
    return this.inner.markSucceeded(runId, options);
  }

  markFailed(
    runId: string,
    error: unknown,
    errorData?: RunLedgerRecord["errorData"],
    options?: Parameters<RunLedger["markFailed"]>[3],
  ): Promise<RunLedgerRecord> {
    this.calls.push("markFailed");
    return this.inner.markFailed(runId, error, errorData, options);
  }

  markCancelled(
    runId: string,
    reason?: string,
    options?: Parameters<RunLedger["markCancelled"]>[2],
  ): Promise<RunLedgerRecord> {
    this.calls.push("markCancelled");
    return this.inner.markCancelled(runId, reason, options);
  }

  markRunInterrupted(
    ...args: Parameters<RunLedger["markRunInterrupted"]>
  ): Promise<RunLedgerRecord> {
    return this.inner.markRunInterrupted(...args);
  }

  markInterrupted(
    options?: MarkInterruptedOptions,
  ): Promise<MarkInterruptedResult> {
    this.calls.push("markInterrupted");
    return this.inner.markInterrupted(options);
  }

  recoverOrphanedRuns(
    options?: Parameters<RunLedger["recoverOrphanedRuns"]>[0],
  ): Promise<MarkInterruptedResult> {
    this.calls.push("recoverOrphanedRuns");
    return this.inner.recoverOrphanedRuns(options);
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
  readonly acquired: RecordingSandboxAcquireInput[] = [];
  readonly released: string[] = [];

  acquire(input: RecordingSandboxAcquireInput): Promise<SandboxLease> {
    this.acquired.push(input);
    return Promise.resolve(createTestSandboxLease(input));
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
      messageSnapshot: { content: "Hello" },
    };
    yield {
      type: "llm:complete",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 30,
      finishReason: "stop",
      messageSnapshot: { content: "Hello" },
      tokenUsage: {
        inputBreakdown: {
          cacheRead: 5,
          cacheWrite: 0,
          observed: { cacheRead: true, cacheWrite: false },
          uncached: 2,
        },
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
      },
    };

    return {
      success: true,
      finishReason: "stop",
      finalResponse: "Hello",
    };
  }
}

class UsageLifecycle implements RunLifecycle {
  constructor(
    private readonly terminalReason?: LifecycleResult["terminalReason"],
  ) {}

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

    params.onStepUsage?.({
      step: 1,
      tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
    });
    return {
      success: true,
      finishReason: "stop",
      finalResponse: "done",
      ...(this.terminalReason === undefined
        ? {}
        : { terminalReason: this.terminalReason }),
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        usageComplete: true,
      },
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
        usageRatio: 0.08,
      },
    };
    yield {
      sessionId: params.sessionId,
      step: 1,
      timestamp: 6,
      type: "context:compacting",
    };
    yield {
      composition: {
        "system-prompt": 2,
        "builtin-tools": 1,
        mcp: 0,
        skills: 0,
        conversation: 5,
        "summarized-conversation": 4,
        "subagent-exchanges": 0,
      },
      compaction: {
        status: "compacted",
        usageAfter: {
          contextLimit: 128,
          currentTokens: 12,
          modelId: params.modelId,
          remainingTokens: 116,
          usageRatio: 0.09,
        },
        usageBefore: {
          contextLimit: 128,
          currentTokens: 120,
          modelId: params.modelId,
          remainingTokens: 8,
          usageRatio: 0.94,
        },
      },
      hasSummary: true,
      sessionId: params.sessionId,
      step: 1,
      timestamp: 7,
      type: "context:prepared",
      usage: {
        contextLimit: 128,
        currentTokens: 12,
        modelId: params.modelId,
        remainingTokens: 116,
        usageRatio: 0.09,
      },
    };
    yield {
      messageSnapshot: { content: "Hello" },
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

class FirstScopeBlockingLifecycle implements RunLifecycle {
  readonly firstFinish = createDeferred<undefined>();
  readonly started: string[] = [];
  private firstScopeCalls = 0;

  async *run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void> {
    const scope = params.contextScopeId ?? params.sessionId;
    this.started.push(scope);
    yield {
      type: "llm:start",
      sessionId: params.sessionId,
      step: 1,
      timestamp: 10,
    };
    if (scope === "subagent_1") {
      this.firstScopeCalls += 1;
      if (this.firstScopeCalls === 1) {
        await this.firstFinish.promise;
      }
    }
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
      messageSnapshot: { content: "replacement" },
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
  readonly currentRunInputs?: {
    close(runId: string, reason: string): Promise<void>;
  };
  readonly lifecycle: RunLifecycle;
  readonly runLedger?: RunLedger;
  readonly beforeFinalize?: import("./types.js").RunManagerDeps["beforeFinalize"];
  readonly bridge?: StreamBridge;
  readonly hookExecutor?: HookExecutor;
  readonly onStepUsage?: RunStepUsageObserver;
  readonly revokePermissionsForRun?: (runId: string, reason: string) => void;
  readonly sandboxManager?: SandboxManager;
}): ManagerFixture {
  const fixture = createManager(input.lifecycle);
  const manager = new RunManager({
    lifecycle: input.lifecycle,
    beforeFinalize: input.beforeFinalize,
    currentRunInputs: input.currentRunInputs,
    revokePermissionsForRun: input.revokePermissionsForRun,
    runLedger: input.runLedger ?? fixture.ledger,
    streamBridge: input.bridge ?? fixture.bridge,
    hookExecutor: input.hookExecutor ?? fixture.hooks,
    ...(input.onStepUsage === undefined
      ? {}
      : { onStepUsage: input.onStepUsage }),
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

it("freezes accepted run reasoning and isolates sibling context scopes", async () => {
  const gate = createDeferred();
  const calls: LifecycleSessionParams[] = [];
  const lifecycle: RunLifecycle = {
    async *run(params) {
      calls.push(params);
      await gate.promise;
      yield {
        type: "llm:start",
        sessionId: params.sessionId,
        step: 1,
        timestamp: 1,
      };
      return { success: true, finishReason: "stop", finalResponse: "" };
    },
  };
  const { manager } = createManager(lifecycle);
  const reasoning = { effort: "high" };
  const first = await manager.create({
    directory: "/repo",
    modelId: "model",
    sessionId: "siblings",
    contextScopeId: "one",
    triggerSource: "user",
    reasoning,
  });
  reasoning.effort = "low";
  const second = await manager.create({
    directory: "/repo",
    modelId: "model",
    sessionId: "siblings",
    contextScopeId: "two",
    triggerSource: "user",
    reasoning: { enabled: false, effort: "high" },
  });
  expect(manager.getActiveReasoning("siblings", "one")).toEqual({
    enabled: true,
    effort: "high",
    explicit: { enabled: false, effort: true },
  });
  expect(manager.getActiveReasoning("siblings", "two")?.enabled).toBe(false);
  expect(manager.getActiveReasoning("siblings")).toBeUndefined();
  gate.resolve();
  await Promise.all([
    manager.waitForCompletion(first.runId),
    manager.waitForCompletion(second.runId),
  ]);
  expect(calls.map((call) => call.reasoning?.effort)).toEqual(["high", "high"]);
  expect(manager.getActiveReasoning("siblings", "one")).toBeUndefined();
});

describe("RunManager", () => {
  it("preserves fatal persistence failure instead of reporting an abort as user cancellation", async () => {
    const lifecycle = new AbortAwareLifecycle();
    const { manager, ledger, hooks } = createManager(lifecycle);
    const record = await manager.create({
      sessionId: "fatal_session",
      triggerSource: "user",
      directory: "/repo",
      modelId: "test",
    });
    await lifecycle.started.promise;
    manager.fail(record.runId, new Error("subagent database failed"));
    manager.cancel(record.runId, "late user cancellation");
    const completion = await manager.waitForCompletion(record.runId);
    expect(completion).toMatchObject({
      status: "failed",
      error: "subagent database failed",
    });
    expect((await ledger.get(record.runId))?.status).toBe("failed");
    expect(hooks.contexts.at(-1)).toMatchObject({
      status: "failed",
      error: "subagent database failed",
    });
  });
  it("passes the lifecycle's final body through this run's completion", async () => {
    const { manager } = createManager(new SessionLifecycle());
    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(
      manager.waitForCompletion(record.runId),
    ).resolves.toMatchObject({
      status: "succeeded",
      finalResponse: "Hello",
    });
  });

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
      finalResponse: "Hello",
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
      "run.context.compacting",
      "run.context.prepared",
      "message.part.delta",
      "run.turn.end",
      "run.updated",
    ]);
    expect(
      bridge.events.find((event) => event.event === "run.context.prepared")
        ?.data,
    ).toMatchObject({
      composition: {
        "system-prompt": 2,
        "builtin-tools": 1,
        conversation: 5,
        "summarized-conversation": 4,
      },
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
    expect(
      bridge.events.find((event) => event.event === "run.llm.start"),
    ).toMatchObject({
      data: {
        runId: "run_1",
        sessionId: "session_1",
        step: 1,
      },
      event: "run.llm.start",
      scope: "run/run_1",
    });
    expect(
      bridge.events.find((event) => event.event === "run.llm.complete"),
    ).toMatchObject({
      data: {
        sessionId: "session_1",
        step: 1,
        tokenUsage: {
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
        },
      },
      event: "run.llm.complete",
      scope: "run/run_1",
    });
    expect(bridge.endedScopes).toEqual(["run/run_1"]);
    expect(sandboxManager.released).toEqual(["lease_session_1"]);
    expect(manager.list("session_1")).toEqual([]);
  });

  it("passes context scope identity to lifecycle", async () => {
    const lifecycle = new CompletingLifecycle();
    const { bridge, manager, sandboxManager } = createManager(lifecycle);

    const record = await manager.create({
      agentInstanceId: "subagent_1",
      contextScopeId: "subagent_1",
      directory: "D:/repo",
      initiatingUserMessageId: "user_child_1",
      isSubagent: true,
      modelId: "fake-model",
      parentMessageId: "assistant_parent_1",
      sessionId: "child_1",
      triggerSource: "user",
    });
    await manager.waitForCompletion(record.runId);

    expect(lifecycle.calls[0]).toMatchObject({
      runId: record.runId,
      contextScopeId: "subagent_1",
      directory: "D:/repo",
      initiatingUserMessageId: "user_child_1",
      isSubagent: true,
      modelId: "fake-model",
      parentMessageId: "assistant_parent_1",
      sessionId: "child_1",
    });
    expect(sandboxManager.acquired[0]).toEqual({
      contextScopeId: "subagent_1",
      sessionId: "child_1",
      workdir: "D:/repo",
    });
    expect(
      bridge.events.find((event) => event.event === "run.llm.start"),
    ).toMatchObject({
      data: {
        contextScopeId: "subagent_1",
        sessionId: "child_1",
      },
    });
  });

  it("allows concurrent runs in the same session when context scopes differ", async () => {
    const lifecycle = new BlockingLifecycle();
    const { manager, sandboxManager } = createManager(lifecycle);

    const first = await manager.create({
      contextScopeId: "subagent_1",
      directory: "D:/repo/one",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      triggerSource: "user",
    });
    await lifecycle.started.promise;

    const second = await manager.create({
      contextScopeId: "subagent_2",
      directory: "D:/repo/two",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      triggerSource: "user",
    });

    await vi.waitFor(() => {
      expect(sandboxManager.acquired).toEqual([
        {
          contextScopeId: "subagent_1",
          sessionId: "child_1",
          workdir: "D:/repo/one",
        },
        {
          contextScopeId: "subagent_2",
          sessionId: "child_1",
          workdir: "D:/repo/two",
        },
      ]);
    });
    expect(manager.list("child_1").map((record) => record.runId)).toEqual([
      first.runId,
      second.runId,
    ]);
    await expect(
      manager.create({
        contextScopeId: "subagent_1",
        directory: "D:/repo",
        isSubagent: true,
        modelId: "fake-model",
        sessionId: "child_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(ConcurrencyRejectedError);

    lifecycle.finish.resolve(undefined);
    await Promise.all([
      manager.waitForCompletion(first.runId),
      manager.waitForCompletion(second.runId),
    ]);
    expect(sandboxManager.released).toEqual([
      "lease_child_1::subagent_1",
      "lease_child_1::subagent_2",
    ]);
  });

  it("isolates initiating user identity by scope and leaves resume runs absent", async () => {
    const lifecycle = new CompletingLifecycle();
    const { manager } = createManager(lifecycle);

    const records = await Promise.all([
      manager.create({
        contextScopeId: "primary_scope",
        directory: "D:/repo",
        initiatingUserMessageId: "user_primary",
        modelId: "fake-model",
        parentMessageId: "parent_primary",
        sessionId: "shared_session",
        triggerSource: "user",
      }),
      manager.create({
        contextScopeId: "subagent_scope",
        directory: "D:/repo",
        initiatingUserMessageId: "user_subagent",
        isSubagent: true,
        modelId: "fake-model",
        parentMessageId: "parent_subagent",
        sessionId: "shared_session",
        triggerSource: "user",
      }),
    ]);
    await Promise.all(
      records.map((record) => manager.waitForCompletion(record.runId)),
    );

    const resume = await manager.create({
      contextScopeId: "primary_scope",
      directory: "D:/repo",
      modelId: "fake-model",
      parentMessageId: "assistant_resume_parent",
      sessionId: "shared_session",
      triggerSource: "user",
    });
    await manager.waitForCompletion(resume.runId);

    expect(
      lifecycle.calls.find((call) => call.contextScopeId === "subagent_scope"),
    ).toMatchObject({
      initiatingUserMessageId: "user_subagent",
      parentMessageId: "parent_subagent",
    });
    const primaryCalls = lifecycle.calls.filter(
      (call) => call.contextScopeId === "primary_scope",
    );
    expect(primaryCalls[0]).toMatchObject({
      initiatingUserMessageId: "user_primary",
      parentMessageId: "parent_primary",
    });
    expect(primaryCalls[1]).toMatchObject({
      parentMessageId: "assistant_resume_parent",
    });
    expect(primaryCalls[1]).not.toHaveProperty("initiatingUserMessageId");
  });

  it("does not let a blocked replacement in one scope lock a sibling scope", async () => {
    const lifecycle = new FirstScopeBlockingLifecycle();
    const { manager } = createManager(lifecycle);
    const first = await manager.create({
      contextScopeId: "subagent_1",
      directory: "D:/repo/one",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      triggerSource: "user",
    });
    await vi.waitFor(() => {
      expect(lifecycle.started).toContain("subagent_1");
    });

    const replacement = manager.create({
      contextScopeId: "subagent_1",
      directory: "D:/repo/one",
      explicit: { multitaskStrategy: "interrupt-current" },
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      triggerSource: "user",
    });
    const sibling = await manager.create({
      contextScopeId: "subagent_2",
      directory: "D:/repo/two",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      triggerSource: "user",
    });
    await vi.waitFor(() => {
      expect(lifecycle.started).toContain("subagent_2");
    });
    await expect(manager.waitForCompletion(sibling.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "",
    });

    lifecycle.firstFinish.resolve(undefined);
    const next = await replacement;
    await expect(manager.waitForCompletion(first.runId)).resolves.toMatchObject(
      {
        status: "cancelled",
      },
    );
    await expect(manager.waitForCompletion(next.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "",
    });
  });

  it("returns lifecycle token usage in run completion", async () => {
    const { manager } = createManager(new UsageLifecycle());

    const record = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(manager.waitForCompletion(record.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "done",
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        usageComplete: true,
      },
    });
  });

  it.each([false, true])(
    "observes scoped step usage exactly once across repeated waits (subagent=%s)",
    async (isSubagent) => {
      const observations: Parameters<RunStepUsageObserver>[0][] = [];
      const { manager } = createManagerWithOverrides({
        lifecycle: new UsageLifecycle(),
        onStepUsage(observation): void {
          observations.push(observation);
        },
      });
      const record = await manager.create({
        directory: "D:/repo",
        isSubagent,
        contextScopeId: "scope_1",
        modelId: "fake-model",
        sessionId: "session_1",
        triggerSource: "user",
      });

      await Promise.all([
        manager.waitForCompletion(record.runId),
        manager.waitForCompletion(record.runId),
      ]);

      expect(observations).toEqual([
        {
          isSubagent,
          contextScopeId: "scope_1",
          runId: record.runId,
          step: 1,
          sessionId: "session_1",
          tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
        },
      ]);
    },
  );

  it("preserves returned usage when cancellation lands in the post-run hook", async () => {
    const managerRef: { current?: RunManager } = {};
    const observations: Parameters<RunStepUsageObserver>[0][] = [];
    const hookExecutor: HookExecutor = {
      execute(point, context): Promise<void> {
        if (point === "post-run") {
          managerRef.current?.cancel(context.runId, "late cancellation");
        }
        return Promise.resolve();
      },
    };
    const fixture = createManagerWithOverrides({
      hookExecutor,
      lifecycle: new UsageLifecycle("completed"),
      onStepUsage(observation): void {
        observations.push(observation);
      },
    });
    managerRef.current = fixture.manager;
    const record = await fixture.manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(
      fixture.manager.waitForCompletion(record.runId),
    ).resolves.toEqual({
      error: "late cancellation",
      status: "interrupted",
      terminalReason: "cancelled",
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        totalTokens: 12,
        usageComplete: true,
      },
    });
    expect(observations).toEqual([
      {
        runId: record.runId,
        step: 1,
        sessionId: "session_1",
        tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      },
    ]);
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
      finalResponse: "done",
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
        status: "pending",
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
      finalResponse: "done",
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

  it("does not add an active record when the ledger rejects a same-session claim", async () => {
    const { manager, ledger, bridge } = createManager(
      new CompletingLifecycle(),
    );
    await ledger.claimPendingRun({
      runId: "run_external",
      sessionId: "session_1",
      triggerSource: "user",
    });

    await expect(
      manager.create({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_1",
        triggerSource: "user",
      }),
    ).rejects.toBeInstanceOf(SessionRunBusyError);

    expect(manager.list("session_1")).toEqual([]);
    expect(bridge.events).toEqual([]);
  });

  it("propagates cancel through AbortSignal and marks the run interrupted", async () => {
    const lifecycle = new AbortAwareLifecycle();
    const observations: Parameters<RunStepUsageObserver>[0][] = [];
    const { manager, ledger, bridge } = createManagerWithOverrides({
      lifecycle,
      onStepUsage(observation): void {
        observations.push(observation);
      },
    });
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
      status: "interrupted",
      error: "user requested stop",
      terminalReason: "cancelled",
    });
    await expect(ledger.get(record.runId)).resolves.toMatchObject({
      status: "interrupted",
      error: "user requested stop",
    });
    expect(bridge.endedScopes).toEqual(["run/run_override"]);
    expect(observations).toEqual([]);
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
      finalResponse: "Hello",
    });
    expect(sandboxManager.released).toEqual(["lease_session_1"]);
    expect(bridge.endedScopes).toEqual(["run/run_override"]);
    expect(manager.hasActiveWork()).toBe(true);
    await expect(manager.waitForCleanup()).rejects.toThrow(
      "Sandbox release remains unconfirmed",
    );
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
      finalResponse: "Hello",
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
      terminalReason: "cancelled",
    });
    await expect(manager.waitForCompletion(second.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "replacement",
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
      errorData: {
        code: "RUNTIME_ERROR",
        message: "lifecycle exploded",
        retryable: false,
        source: "runtime",
      },
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
      errorData: {
        code: "CONTEXT_OVERFLOW",
        message: "Context overflow after forced compaction retry",
        retryable: false,
        source: "runtime",
        terminalReason: "context_overflow",
      },
      terminalReason: "context_overflow",
    });
    expect(
      bridge.events.filter((event) => event.event === "run.updated").at(-1)
        ?.data,
    ).toMatchObject({
      run: {
        runId: failed.runId,
        status: "failed",
        terminalReason: "context_overflow",
      },
    });
  });

  it("leaves records with unknown owners untouched during online init", async () => {
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

    await expect(manager.init()).resolves.toEqual({ updatedCount: 0 });
    await expect(manager.init()).resolves.toEqual({ updatedCount: 0 });
    await expect(ledger.get("pending_run")).resolves.toMatchObject({
      status: "pending",
    });
    await expect(ledger.get("running_run")).resolves.toMatchObject({
      status: "running",
    });
  });

  it("throws when cancelling an unknown run", () => {
    const { manager } = createManager(new CompletingLifecycle());

    expect(() => {
      manager.cancel("missing_run");
    }).toThrow(RunManagerNotFoundError);
  });
});

describe("run permission cleanup", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "settles a real orphaned wait at the worker terminal (child=%s, failure=%s)",
    async (isSubagent, fails) => {
      const permission = createPermissionManager({ bus: createBus() });
      let waiting: Promise<SchedulerPermissionResponse> | undefined;
      let requestId = "";
      const lifecycle: RunLifecycle = {
        async *run(params) {
          if (!params.runId || !params.signal)
            throw new Error("Missing identity");
          waiting = permission.ask({
            runId: params.runId,
            sessionId: params.sessionId,
            callId: "terminal_call",
            messageId: "terminal_message",
            toolName: "bash",
            params: { command: "printf terminal" },
            category: "dangerous",
            signal: params.signal,
            source: {
              rootSessionId: "root",
              ancestorSessionIds: isSubagent ? ["root"] : [],
              sourceLabel: isSubagent ? "Child" : "Main agent",
            },
          });
          await Promise.resolve();
          requestId = permission.listPending()[0].id;
          yield {
            type: "llm:start",
            sessionId: params.sessionId,
            step: 1,
            timestamp: 1,
          };
          if (fails) throw new Error("Controlled lifecycle failure");
          return { success: true, finishReason: "stop", finalResponse: "done" };
        },
      };
      const { manager } = createManagerWithOverrides({
        lifecycle,
        revokePermissionsForRun: (runId, reason) => {
          permission.revokeByRun(runId, reason);
        },
      });
      const sessionId = isSubagent ? "child" : "root";
      try {
        const run = await manager.create({
          directory: "D:/repo",
          modelId: "fake-model",
          sessionId,
          triggerSource: "user",
          isSubagent,
        });
        const completion = await manager.waitForCompletion(run.runId);
        expect(completion.status).toBe(fails ? "failed" : "succeeded");
        await expect(waiting).resolves.toBe("cancel");
        expect(permission.listPending()).toEqual([]);
        expect(
          permission.respond(sessionId, requestId, { type: "always" }),
        ).toBe("revoked");
        expect(permission.state.getSessionRules(sessionId)).toEqual([]);
      } finally {
        permission.dispose();
      }
    },
  );

  it.each([
    ["success", (): SessionLifecycle => new SessionLifecycle()],
    ["failure", (): ThrowingLifecycle => new ThrowingLifecycle()],
  ] as const)(
    "revokes the actual run on %s before completion",
    async (_name, lifecycle) => {
      const revoked: string[] = [];
      const { manager } = createManagerWithOverrides({
        lifecycle: lifecycle(),
        revokePermissionsForRun(runId) {
          revoked.push(runId);
        },
      });
      const run = await manager.create({
        directory: "D:/repo",
        modelId: "fake-model",
        sessionId: "session_1",
        triggerSource: "user",
      });
      await manager.waitForCompletion(run.runId);
      expect(revoked).toEqual([run.runId]);
    },
  );

  it("revokes synchronously on cancel without waiting for execution cleanup", async () => {
    const lifecycle = new AbortAwareLifecycle();
    const revoked: string[] = [];
    const { manager } = createManagerWithOverrides({
      lifecycle,
      revokePermissionsForRun(runId) {
        revoked.push(runId);
      },
    });
    const run = await manager.create({
      directory: "D:/repo",
      modelId: "fake-model",
      sessionId: "session_1",
      triggerSource: "user",
    });
    await lifecycle.started.promise;
    manager.cancel(run.runId);
    expect(revoked).toEqual([run.runId]);
    await manager.waitForCompletion(run.runId);
    expect(revoked.every((id) => id === run.runId)).toBe(true);
  });
});

it("seals input admission synchronously before cancellation and awaits durable closure before terminal", async () => {
  const lifecycle = new AbortAwareLifecycle();
  const persistence = createDeferred();
  const closed: string[] = [];
  const { manager, ledger } = createManagerWithOverrides({
    lifecycle,
    currentRunInputs: {
      close(runId) {
        closed.push(runId);
        return persistence.promise;
      },
    },
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "fake-model",
    sessionId: "session",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  manager.cancel(run.runId);
  expect(closed).toEqual([run.runId]);
  await Promise.resolve();
  expect((await ledger.get(run.runId))?.status).toBe("running");
  persistence.resolve();
  expect((await manager.waitForCompletion(run.runId)).status).toBe(
    "interrupted",
  );
});

describe("durable run handoff", () => {
  const runOptions = {
    directory: "/repo",
    modelId: "fake-model",
    sessionId: "session_1",
    triggerSource: "user" as const,
  };

  it("keeps the execution slot after a terminal write fails and retries without rerunning", async () => {
    const lifecycle = new CompletingLifecycle();
    const ledger = createInMemoryRunLedger();
    const save = ledger.markSucceeded.bind(ledger);
    let unavailable = true;
    ledger.markSucceeded = async (...args): Promise<RunLedgerRecord> => {
      if (unavailable) throw new Error("disk unavailable");
      return save(...args);
    };
    const { manager, bridge, sandboxManager } = createManagerWithOverrides({
      lifecycle,
      runLedger: ledger,
    });
    const run = await manager.create(runOptions);
    await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
      name: "RunFinalizationError",
      runId: run.runId,
      stage: "run-terminal",
    });
    expect(manager.hasActiveWork()).toBe(true);
    expect(bridge.endedScopes).toEqual([]);
    expect(sandboxManager.released).toHaveLength(1);
    await expect(
      manager.create({
        ...runOptions,
        runId: "replacement",
        explicit: { multitaskStrategy: "interrupt-current" },
      }),
    ).rejects.toMatchObject({ name: "RunFinalizationError" });
    unavailable = false;
    const completions = await Promise.all([
      manager.retryFinalization(run.runId),
      manager.retryFinalization(run.runId),
    ]);
    expect(completions).toEqual([
      { status: "succeeded", finalResponse: "Hello" },
      { status: "succeeded", finalResponse: "Hello" },
    ]);
    expect((await ledger.get(run.runId))?.endedAt).toBe(10_000);
    expect(manager.hasActiveWork()).toBe(false);
    expect(bridge.endedScopes).toEqual([`run/${run.runId}`]);
    expect(lifecycle.calls).toHaveLength(1);
    await expect(manager.retryFinalization(run.runId)).resolves.toEqual(
      completions[0],
    );
  });

  it("retries input closure while preserving the original successful outcome", async () => {
    let unavailable = true;
    const reasons: string[] = [];
    const lifecycle = new CompletingLifecycle();
    const { manager, ledger, bridge } = createManagerWithOverrides({
      lifecycle,
      currentRunInputs: {
        close: async (_runId, reason) => {
          await Promise.resolve();
          reasons.push(reason);
          if (unavailable) throw new Error("input close unavailable");
        },
      },
    });
    const run = await manager.create(runOptions);
    await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
      name: "RunFinalizationError",
      stage: "input-closure",
    });
    expect((await ledger.get(run.runId))?.status).toBe("running");
    expect(bridge.endedScopes).toEqual([]);
    manager.cancel(run.runId, "late stop after main settled");
    unavailable = false;
    await expect(manager.retryFinalization(run.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "Hello",
    });
    expect(reasons).toEqual(["succeeded", "succeeded"]);
    expect(lifecycle.calls).toHaveLength(1);
  });

  it("reconciles a committed terminal when the write response is lost", async () => {
    const ledger = createInMemoryRunLedger({ now: () => 50 });
    const save = ledger.markSucceeded.bind(ledger);
    ledger.markSucceeded = async (...args): Promise<RunLedgerRecord> => {
      await save(...args);
      throw new Error("response lost");
    };
    const { manager } = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      runLedger: ledger,
    });
    const run = await manager.create(runOptions);
    await expect(manager.waitForCompletion(run.runId)).resolves.toEqual({
      status: "succeeded",
      finalResponse: "Hello",
    });
    expect((await ledger.get(run.runId))?.endedAt).toBe(10_000);
    expect(manager.get(run.runId)?.error).toBeUndefined();
  });

  it("preserves the ledger winner instead of publishing a conflicting local outcome", async () => {
    const ledger = createInMemoryRunLedger();
    const lifecycle = new BlockingLifecycle();
    const { manager } = createManagerWithOverrides({
      lifecycle,
      runLedger: ledger,
    });
    const run = await manager.create(runOptions);
    await lifecycle.started.promise;
    await ledger.markCancelled(run.runId, "already committed");
    const committed = await ledger.get(run.runId);
    lifecycle.finish.resolve(undefined);
    await expect(manager.waitForCompletion(run.runId)).resolves.toMatchObject({
      status: "cancelled",
      error: "already committed",
    });
    expect(manager.get(run.runId)?.endedAt).toBe(committed?.endedAt);
  });

  it("does not wait for sandbox cleanup to hand off after durable terminal", async () => {
    const cleanup = createDeferred();
    const sandboxManager = new RecordingSandboxManager();
    sandboxManager.release = (): Promise<void> => cleanup.promise;
    const { manager } = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      sandboxManager,
    });
    const run = await manager.create(runOptions);
    try {
      await expect(
        Promise.race([
          manager.waitForCompletion(run.runId).then(() => "done"),
          new Promise<string>((resolve) =>
            setTimeout(() => {
              resolve("blocked");
            }, 50),
          ),
        ]),
      ).resolves.toBe("done");
      expect(manager.hasActiveWork()).toBe(true);
    } finally {
      cleanup.resolve();
    }
    await manager.waitForCleanup();
    expect(manager.hasActiveWork()).toBe(false);
  });

  it("cannot bypass locally pending finalization by initializing again", async () => {
    const ledger = createInMemoryRunLedger();
    ledger.markSucceeded = (): Promise<RunLedgerRecord> =>
      Promise.reject(new Error("save unavailable"));
    const { manager } = createManagerWithOverrides({
      lifecycle: new CompletingLifecycle(),
      runLedger: ledger,
    });
    const run = await manager.create(runOptions);
    await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
      name: "RunFinalizationError",
    });
    await expect(manager.init()).rejects.toMatchObject({
      name: "ConcurrencyRejectedError",
    });
    expect(manager.hasActiveWork()).toBe(true);
  });
});

it("keeps fatal history facts gated and retries the owning history finalizer", async () => {
  const lifecycle = new AbortAwareLifecycle();
  let unavailable = true;
  const outcomes: import("./types.js").RunWorkerResult[] = [];
  const { manager, ledger } = createManagerWithOverrides({
    lifecycle,
    beforeFinalize: async (_runId, outcome) => {
      await Promise.resolve();
      outcomes.push(outcome);
      if (unavailable) throw new Error("tool history unavailable");
    },
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "fatal",
    triggerSource: "user",
  });
  const signal = await lifecycle.started.promise;
  manager.fail(run.runId, new Error("tool result not saved"));
  expect(signal?.aborted).toBe(true);
  await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
    name: "RunFinalizationError",
    stage: "execution-history",
  });
  expect((await ledger.get(run.runId))?.status).toBe("running");
  expect(manager.hasActiveWork()).toBe(true);
  unavailable = false;
  await expect(manager.retryFinalization(run.runId)).resolves.toMatchObject({
    status: "failed",
    error: "tool result not saved",
    terminalReason: "tool_persistence_failure",
  });
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]).toBe(outcomes[1]);
  expect(manager.hasActiveWork()).toBe(false);
});

it("does not run finalization recovery while the main logic is still executing", async () => {
  const lifecycle = new BlockingLifecycle();
  let historyFinalizations = 0;
  const { manager } = createManagerWithOverrides({
    lifecycle,
    beforeFinalize: async () => {
      await Promise.resolve();
      historyFinalizations++;
    },
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "slow",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  manager.cancel(run.runId, "user-stop");
  const retry = manager.retryFinalization(run.runId);
  await Promise.resolve();
  expect(historyFinalizations).toBe(0);
  expect(manager.hasActiveWork()).toBe(true);
  lifecycle.finish.resolve(undefined);
  await expect(retry).resolves.toMatchObject({ status: "interrupted" });
  expect(historyFinalizations).toBe(1);
});

it("preserves the error from a terminal already committed with the same status", async () => {
  const lifecycle = new BlockingLifecycle();
  const ledger = createInMemoryRunLedger();
  const { manager } = createManagerWithOverrides({
    lifecycle,
    runLedger: ledger,
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "same-status",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  await ledger.markFailed(run.runId, "first durable failure");
  manager.fail(run.runId, new Error("later local failure"));
  lifecycle.finish.resolve(undefined);
  await expect(manager.waitForCompletion(run.runId)).resolves.toMatchObject({
    status: "failed",
    error: "first durable failure",
  });
});

it("finalizes a synchronous sandbox acquire failure without an unobserved run", async () => {
  const sandboxManager = new RecordingSandboxManager();
  sandboxManager.acquire = (): Promise<SandboxLease> => {
    throw new Error("sandbox unavailable");
  };
  const { manager } = createManagerWithOverrides({
    lifecycle: new CompletingLifecycle(),
    sandboxManager,
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "sandbox",
    triggerSource: "user",
  });
  await expect(manager.waitForCompletion(run.runId)).resolves.toMatchObject({
    status: "failed",
    error: "sandbox unavailable",
  });
  expect(manager.hasActiveWork()).toBe(false);
});

it("does not add a hidden retry when Stop input closure already failed before main exit", async () => {
  const lifecycle = new BlockingLifecycle();
  let attempts = 0;
  let unavailable = true;
  const { manager } = createManagerWithOverrides({
    lifecycle,
    currentRunInputs: {
      close: async () => {
        await Promise.resolve();
        attempts++;
        if (unavailable) throw new Error("close unavailable");
      },
    },
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "stop-retry",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  manager.cancel(run.runId, "user-stop");
  await expect(manager.waitForInputClosure(run.runId)).rejects.toThrow(
    "close unavailable",
  );
  lifecycle.finish.resolve(undefined);
  await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
    stage: "input-closure",
  });
  expect(attempts).toBe(1);
  unavailable = false;
  await expect(manager.retryFinalization(run.runId)).resolves.toMatchObject({
    status: "interrupted",
  });
  expect(attempts).toBe(2);
});

it("uses Stop's expired save budget until an explicit singleflight retry starts a fresh attempt", async () => {
  const db = new NodeSqliteConnection(":memory:");
  const lifecycle = new BlockingLifecycle();
  const budgets: ReturnType<typeof getDatabaseWriteBudget>[] = [];
  let historyCalls = 0;
  const { manager, ledger } = createManagerWithOverrides({
    lifecycle,
    currentRunInputs: {
      close: () => {
        budgets.push(getDatabaseWriteBudget());
        return Promise.resolve();
      },
    },
    beforeFinalize: async () => {
      historyCalls++;
      budgets.push(getDatabaseWriteBudget());
      await runWriteTransaction(db, () => {
        if (historyCalls === 1) {
          const until = performance.now() + 50;
          while (performance.now() < until) {
            /* A slow synchronous database callback consumes the save allowance. */
          }
        }
      });
    },
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "budget",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  const original = createDatabaseWriteBudget(30);
  withDatabaseWriteBudget(original, () => {
    manager.cancel(run.runId, "user-stop");
  });
  lifecycle.finish.resolve(undefined);
  await expect(manager.waitForCompletion(run.runId)).rejects.toMatchObject({
    stage: "execution-history",
    cause: { name: "DatabaseWriteBudgetError" },
  });
  expect(budgets).toEqual([original, original]);
  expect((await ledger.get(run.runId))?.status).toBe("running");
  const retry = manager.retryFinalization(run.runId);
  expect(manager.retryFinalization(run.runId)).toBe(retry);
  await expect(retry).resolves.toMatchObject({ status: "interrupted" });
  expect(historyCalls).toBe(2);
  expect(budgets[2]?.deadlineAt).toBeGreaterThan(original.deadlineAt);
  db.close();
});

it("persists Stop input immediately and finalizes after a slow main exit without spending idle time as DB wait", async () => {
  const db = new NodeSqliteConnection(":memory:");
  db.exec("CREATE TABLE facts(value TEXT)");
  const lifecycle = new BlockingLifecycle();
  const { manager } = createManagerWithOverrides({
    lifecycle,
    currentRunInputs: {
      close: () =>
        runWriteTransaction(db, (connection) => {
          connection.prepare("INSERT INTO facts VALUES ('closed')").run();
        }),
    },
    beforeFinalize: () =>
      runWriteTransaction(db, (connection) => {
        connection.prepare("INSERT INTO facts VALUES ('final')").run();
      }),
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "slow-stop",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  try {
    manager.cancel(run.runId, "user-stop");
    await manager.waitForInputClosure(run.runId);
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "closed" },
    ]);
    // Real wall time: the previous fixed five-second deadline wrongly expires here.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    lifecycle.finish.resolve(undefined);
    await expect(manager.waitForCompletion(run.runId)).resolves.toMatchObject({
      status: "interrupted",
    });
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "closed" },
      { value: "final" },
    ]);
  } finally {
    lifecycle.finish.resolve(undefined);
    await manager.waitForCompletion(run.runId).catch(() => undefined);
    db.close();
  }
}, 10_000);

it("continues shutdown cancellation for other runs when one permission revocation throws", async () => {
  const signals = new Map<string, AbortSignal | undefined>();
  const lifecycle: RunLifecycle = {
    async *run(params) {
      signals.set(params.sessionId, params.signal);
      yield {
        type: "llm:start",
        sessionId: params.sessionId,
        step: 1,
        timestamp: 1,
      };
      if (!params.signal?.aborted)
        await new Promise<void>((resolve) =>
          params.signal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            {
              once: true,
            },
          ),
        );
      return { success: false, finishReason: "error", finalResponse: "" };
    },
  };
  const { manager } = createManagerWithOverrides({
    lifecycle,
    revokePermissionsForRun: (runId) => {
      if (runId === "first") throw new Error("permission unavailable");
    },
  });
  for (const runId of ["first", "second"])
    await manager.create({
      runId,
      directory: "/repo",
      modelId: "test",
      sessionId: runId,
      triggerSource: "user",
    });
  await vi.waitFor(() => {
    expect(signals.size).toBe(2);
  });
  await expect(manager.cancelAll("service-shutdown")).rejects.toThrow();
  expect(signals.get("first")?.aborted).toBe(true);
  expect(signals.get("second")?.aborted).toBe(true);
  await expect(manager.waitForCompletion("second")).resolves.toMatchObject({
    status: "interrupted",
  });
});

it("returns durable error details when a committed failure has the same message", async () => {
  const lifecycle = new BlockingLifecycle();
  const ledger = createInMemoryRunLedger();
  const { manager } = createManagerWithOverrides({
    lifecycle,
    runLedger: ledger,
  });
  const run = await manager.create({
    directory: "/repo",
    modelId: "test",
    sessionId: "durable-error",
    triggerSource: "user",
  });
  await lifecycle.started.promise;
  await ledger.markFailed(run.runId, "same failure", {
    code: "DURABLE_FAILURE",
    message: "same failure",
    source: "runtime",
    retryable: false,
  });
  manager.fail(run.runId, new Error("same failure"));
  lifecycle.finish.resolve(undefined);
  await expect(manager.waitForCompletion(run.runId)).resolves.toMatchObject({
    status: "failed",
    errorData: { code: "DURABLE_FAILURE" },
  });
});
