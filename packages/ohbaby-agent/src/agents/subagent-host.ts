import { createHash } from "node:crypto";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
  ExecutionTerminalResult,
} from "./subagents/execution-store.js";
import {
  mergeReasoningIntent,
  type ReasoningIntent,
} from "../services/interface-providers/reasoning.js";
import type {
  AgentInstanceFactory,
  AgentRunResult,
} from "../core/agents/index.js";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/index.js";
import type { Session, SessionManager } from "../services/session/index.js";
import { createDeadlineController } from "./deadline.js";
import type { AgentManager } from "./manager.js";
import type { SubagentRole } from "./roles.js";
import type {
  QueuedSubagentInput,
  MarkSubagentsInterruptedInput,
  SubagentCloseResult,
  SubagentInstanceRecord,
  SubagentInstanceStore,
  SubagentLookupInput,
  SubagentRunInput,
  SubagentRunResult,
  SubagentStatusInput,
  SubagentStatusResult,
} from "./subagents/index.js";

interface ActiveSubagentState {
  abortController?: AbortController;
  currentExecution?: ActiveQueuedSubagentInput;
  claimCompletion?: DeferredClaim;
  closed: boolean;
  drainPromise?: Promise<void>;
  drainAfterInterrupt: boolean;
  lastRunSettled: boolean;
  pendingSettlement?: Promise<void>;
  readonly parentSessionId: string;
  readonly pauseController: AbortController;
  pauseReason?: string;
  queue: ActiveQueuedSubagentInput[];
  running: boolean;
  stopping: boolean;
}

interface ActiveQueuedSubagentInput extends QueuedSubagentInput {
  readonly reasoning?: ReasoningIntent;
  readonly completion?: DeferredCompletion;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
  unbindQueueAbort?: () => void;
}

interface EntryOutcome {
  readonly item: SubagentInstanceRecord;
  readonly paused?: true;
}

interface DeferredCompletion {
  readonly promise: Promise<EntryOutcome>;
  reject(error: unknown): void;
  resolve(outcome: EntryOutcome): void;
}

interface DeferredClaim {
  readonly promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
}

export interface SessionSubagentHostOptions {
  readonly executionStore: SubagentExecutionStore;
  readonly resolveRequester: (input: SubagentRunInput) => Promise<{
    readonly rootSessionId: string;
    readonly rootRunId: string;
    readonly rootPromptId?: string;
  }>;
  readonly onTerminal?: (
    record: SubagentExecutionRecord,
  ) => void | Promise<void>;
  readonly onFatal?: (error: Error, rootRunId: string) => void;
  readonly getParentReasoning?: (
    sessionId: string,
    contextScopeId?: string,
  ) => ReasoningIntent | undefined;
  readonly agentManager: Pick<AgentManager, "getRuntimeAgent">;
  readonly instanceFactory: AgentInstanceFactory;
  readonly modelId: string;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly store: SubagentInstanceStore;
  readonly createSubagentId?: () => string;
  readonly createRunId?: () => string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly now?: () => number;
  readonly onClosed?: (input: {
    readonly contextScopeId: string;
    readonly runId?: string;
    readonly sessionId: string;
    readonly subagentId: string;
  }) => void;
}

export const PRIMARY_SUBAGENT_REQUESTER_SCOPE = "primary";
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SUBAGENT_TIMEOUT_MS = DEFAULT_SUBAGENT_TIMEOUT_MS;

function defaultSubagentId(): string {
  return `subagent_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function defaultRunId(): string {
  return `subagent_run_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successfulOutput(result: AgentRunResult): {
  readonly output: string;
  readonly success: boolean;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
} {
  if (result.mode !== "waitForCompletion") {
    return {
      output: "Subagent expected a completed agent run",
      success: false,
      status: "failed",
    };
  }
  return result.success
    ? { output: result.finalOutput, success: true, status: "completed" }
    : {
        output: result.error,
        success: false,
        status:
          result.runStatus === "cancelled" || result.runStatus === "interrupted"
            ? result.runStatus
            : "failed",
      };
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("subagent timeoutMs must be a positive number");
  }
  if (timeoutMs > MAX_SUBAGENT_TIMEOUT_MS) {
    throw new Error("subagent timeoutMs must not exceed 1800000ms");
  }
  return Math.trunc(timeoutMs);
}

function timeoutMessage(timeoutMs: number): string {
  return `Subagent timed out after ${String(timeoutMs)}ms`;
}

async function waitForTurnOrAbort(
  turn: Promise<AgentRunResult>,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "aborted" }
  | { readonly kind: "completed"; readonly result: AgentRunResult }
> {
  if (signal.aborted) {
    return { kind: "aborted" };
  }
  let onAbort!: () => void;
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    onAbort = (): void => {
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      turn.then((result) => ({ kind: "completed" as const, result })),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForSettlementOrAbort(
  settlement: Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  let onAbort!: () => void;
  const aborted = new Promise<false>((resolve) => {
    onAbort = (): void => {
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settlement.then(() => true as const), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class SessionSubagentHost {
  private readonly active = new Map<string, ActiveSubagentState>();
  private readonly parentSessionLocks = new Map<string, Promise<void>>();
  private readonly subagentLocks = new Map<string, Promise<void>>();
  private readonly settlingTurns = new Map<string, Promise<void>>();
  private readonly createSubagentId: () => string;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private disposed = false;
  private readonly sealedRoots = new Set<string>();
  private readonly closedSubagents = new Set<string>();
  private readonly invocationLocks = new Map<string, Promise<void>>();
  private readonly executionJobs = new Map<string, Promise<EntryOutcome>>();
  private readonly rootByExecution = new Map<string, string>();

  constructor(private readonly options: SessionSubagentHostOptions) {
    this.createSubagentId = options.createSubagentId ?? defaultSubagentId;
    this.createRunId = options.createRunId ?? defaultRunId;
    this.now = options.now ?? Date.now;
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    if (this.disposed) throw new Error("Subagent host is disposed");
    for (const identity of [
      input.requesterRunId,
      input.requesterMessageId,
      input.requestId,
    ]) {
      if (typeof identity !== "string" || !identity.trim())
        throw new Error("Subagent requester identity is required");
    }
    const requestedTimeout = normalizeTimeoutMs(input.timeoutMs);
    const root = await this.options.resolveRequester(input);
    this.assertRootOpen(root.rootRunId);
    if (input.signal?.aborted)
      throw new Error("Subagent requester was stopped");
    const requestId = JSON.stringify([
      input.requesterMessageId,
      input.requestId,
    ]);
    const executionId = `subagent_execution_${createHash("sha256")
      .update(JSON.stringify([input.requesterRunId, requestId]))
      .digest("hex")}`;
    const requesterScopeId =
      input.parentContextScopeId ?? PRIMARY_SUBAGENT_REQUESTER_SCOPE;
    const lookup = {
      executionId,
      parentSessionId: input.parentSessionId,
      requesterScopeId,
    };
    let release!: () => void;
    const previous = this.invocationLocks.get(executionId);
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.invocationLocks.set(executionId, lock);
    await previous;
    let execution: SubagentExecutionRecord;
    try {
      this.assertRootOpen(root.rootRunId);
      const prior = await this.options.executionStore.get(lookup);
      const existing =
        input.subagentId === undefined
          ? undefined
          : await this.getExisting(input);
      const timeoutMs =
        requestedTimeout ??
        Math.min(
          existing?.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
          MAX_SUBAGENT_TIMEOUT_MS,
        );
      this.assertRootOpen(root.rootRunId);
      const accepted = await this.options.executionStore.accept({
        ...lookup,
        ...root,
        requesterRunId: input.requesterRunId,
        requestId,
        subagentId:
          input.subagentId ?? prior?.subagentId ?? this.createSubagentId(),
        mode: input.mode,
        prompt: input.prompt,
        timeoutMs,
        createdAt: this.now(),
      });
      execution = accepted.record;
      this.rootByExecution.set(executionId, root.rootRunId);
      if (this.sealedRoots.has(root.rootRunId)) {
        await this.options.executionStore.interruptRoot(
          root.rootRunId,
          "parent run interrupted",
          this.now(),
        );
        throw new Error("Subagent root run is closed");
      }
      if (accepted.created) {
        const inherited = this.options.getParentReasoning?.(
          input.parentSessionId,
          input.parentContextScopeId,
        );
        const job = Promise.resolve().then(async () => {
          try {
            this.assertRootOpen(root.rootRunId);
            const record =
              existing ??
              (await this.withParentSessionLock(input.parentSessionId, () =>
                this.createRecord(
                  { ...input, subagentId: execution.subagentId, timeoutMs },
                  execution,
                ),
              ));
            this.assertRootOpen(root.rootRunId);
            if (this.closedSubagents.has(execution.subagentId))
              throw new Error("Subagent is closed");
            await this.options.executionStore.bindChild(
              lookup,
              {
                sessionId: record.sessionId,
                contextScopeId: record.contextScopeId,
              },
              this.now(),
            );
            this.assertRootOpen(root.rootRunId);
            return await this.enqueueOrSchedule(
              record,
              input.prompt,
              input.environment,
              input.interrupt === true,
              timeoutMs,
              true,
              input.mode === "foreground" ? input.signal : undefined,
              existing === undefined,
              inherited === undefined
                ? undefined
                : mergeReasoningIntent(inherited),
              execution,
            );
          } catch (error) {
            if (
              !(error instanceof SubagentPersistenceError) &&
              !(
                input.mode === "foreground" &&
                input.signal?.aborted &&
                !this.sealedRoots.has(root.rootRunId)
              )
            ) {
              await this.finishExecution(execution, {
                status: this.sealedRoots.has(root.rootRunId)
                  ? "interrupted"
                  : "failed",
                error: errorMessage(error),
                reason: errorMessage(error),
                completedAt: this.now(),
              });
            }
            throw error;
          }
        });
        this.executionJobs.set(executionId, job);
        void job
          .catch(() => undefined)
          .finally(() => {
            if (this.executionJobs.get(executionId) === job)
              this.executionJobs.delete(executionId);
          });
      }
    } finally {
      release();
      if (this.invocationLocks.get(executionId) === lock)
        this.invocationLocks.delete(executionId);
    }
    if (input.mode === "background") {
      // Return the accepted snapshot, never a racing instance's latest report.
      const {
        output: _output,
        error: _error,
        lateResult: _lateResult,
        ...receipt
      } = execution;
      return { execution: receipt };
    }
    const outcome = await this.executionJobs.get(executionId);
    const result = await this.withSubagentLock(execution.subagentId, () =>
      this.options.executionStore.get(lookup),
    );
    if (!result) throw new Error("Accepted subagent execution disappeared");
    const item =
      (outcome?.item &&
      (outcome.paused || outcome.item.status === result.status)
        ? outcome.item
        : undefined) ??
      (await this.options.store.get({
        parentSessionId: input.parentSessionId,
        subagentId: result.subagentId,
      }));
    return {
      execution: result,
      ...(item ? { item } : {}),
      ...(outcome?.paused ? { paused: true } : {}),
      output: result.output ?? result.error,
      success: result.status === "completed",
    };
  }

  private assertRootOpen(rootRunId: string): void {
    if (this.disposed || this.sealedRoots.has(rootRunId))
      throw new Error("Subagent root run is closed");
  }

  private async finishExecution(
    execution: Pick<
      SubagentExecutionRecord,
      "executionId" | "parentSessionId" | "rootRunId"
    >,
    result: ExecutionTerminalResult,
  ): Promise<SubagentExecutionRecord> {
    try {
      const finished = await this.options.executionStore.finish(
        execution,
        result,
      );
      if (finished.claimed) await this.options.onTerminal?.(finished.record);
      return finished.record;
    } catch (error) {
      this.sealedRoots.add(execution.rootRunId);
      const failure = new SubagentPersistenceError(errorMessage(error));
      this.options.onFatal?.(failure, execution.rootRunId);
      throw failure;
    }
  }

  async interruptByRootRun(
    rootRunId: string,
    reason = "parent run interrupted",
  ): Promise<readonly SubagentExecutionRecord[]> {
    // This seal precedes every await and prevents a late creation callback starting work.
    this.sealedRoots.add(rootRunId);
    for (const active of this.active.values()) {
      if (active.currentExecution?.rootRunId === rootRunId)
        active.abortController?.abort(reason);
    }
    const interrupted = await this.options.executionStore.interruptRoot(
      rootRunId,
      reason,
      this.now(),
    );
    for (const [subagentId, active] of this.active) {
      await this.withSubagentLock(subagentId, async () => {
        const removed = active.queue.filter(
          (entry) => entry.rootRunId === rootRunId,
        );
        active.queue = active.queue.filter(
          (entry) => entry.rootRunId !== rootRunId,
        );
        const item = await this.options.store.update(subagentId, {
          pendingQueue: this.serializeQueue(active.queue),
          updatedAt: this.now(),
        });
        this.resolveQueuedCompletions(removed, item);
      });
    }
    for (const record of interrupted) await this.options.onTerminal?.(record);
    return interrupted;
  }

  async status(input: SubagentStatusInput): Promise<SubagentStatusResult> {
    const items = input.subagentId
      ? [
          await this.options.store.get({
            parentSessionId: input.parentSessionId,
            subagentId: input.subagentId,
          }),
        ].filter((item): item is SubagentInstanceRecord => item !== null)
      : await this.options.store.listByParent(input.parentSessionId);
    const requesterScopeId =
      input.parentContextScopeId ?? PRIMARY_SUBAGENT_REQUESTER_SCOPE;
    const executions = input.executionId
      ? [
          await this.options.executionStore.get({
            parentSessionId: input.parentSessionId,
            requesterScopeId,
            executionId: input.executionId,
          }),
        ].filter((record): record is SubagentExecutionRecord => record !== null)
      : await this.options.executionStore.list({
          parentSessionId: input.parentSessionId,
          requesterScopeId,
          subagentId: input.subagentId,
          limit: 20,
        });
    return { items, executions };
  }

  async close(input: SubagentLookupInput): Promise<SubagentCloseResult> {
    return this.withSubagentLock(input.subagentId, async () => {
      const item = await this.options.store.get(input);
      if (!item) {
        const executions = await this.options.executionStore.list({
          parentSessionId: input.parentSessionId,
          subagentId: input.subagentId,
          limit: 200,
        });
        if (executions.length === 0)
          throw new Error(`Subagent not found: ${input.subagentId}`);
        this.closedSubagents.add(input.subagentId);
        for (const execution of executions) {
          if (execution.status === "queued" || execution.status === "running")
            await this.finishExecution(execution, {
              status: "cancelled",
              error: "subagent closed",
              reason: "cancelled",
              completedAt: this.now(),
            });
        }
        return {
          subagentId: input.subagentId,
          previousStatus: "pending",
          reason: "subagent closed",
        };
      }
      this.closedSubagents.add(input.subagentId);
      const previousStatus = item.status;
      const active = this.active.get(input.subagentId);
      const queued = active?.queue.splice(0) ?? [];
      if (active) {
        active.closed = true;
        active.pauseController.abort("subagent closed");
        active.abortController?.abort("subagent closed");
      }
      const reason =
        item.currentRunId !== undefined || item.pendingQueue.length > 0
          ? "subagent closed"
          : undefined;
      const closedAt = this.now();
      let before: { createdAt: number; executionId: string } | undefined;
      for (;;) {
        const executions = await this.options.executionStore.list({
          parentSessionId: input.parentSessionId,
          subagentId: input.subagentId,
          limit: 200,
          before,
        });
        for (const execution of executions) {
          if (execution.status === "queued" || execution.status === "running")
            await this.finishExecution(execution, {
              status: "cancelled",
              error: "subagent closed",
              reason: "cancelled",
              completedAt: closedAt,
            });
        }
        if (executions.length < 200) break;
        const last = executions[executions.length - 1];
        before = { createdAt: last.createdAt, executionId: last.executionId };
      }
      const updated = await this.options.store.update(input.subagentId, {
        closedAt,
        ...(reason === undefined ? {} : { error: reason, output: reason }),
        completedAt:
          item.currentRunId === undefined ? item.completedAt : closedAt,
        currentInput: undefined,
        currentRunId: undefined,
        lastRunId: item.currentRunId ?? item.lastRunId,
        pendingQueue: [],
        status: "cancelled",
        updatedAt: closedAt,
      });
      this.resolveQueuedCompletions(queued, updated);
      this.options.onClosed?.({
        contextScopeId: item.contextScopeId,
        sessionId: item.sessionId,
        subagentId: item.subagentId,
        ...(item.currentRunId === undefined
          ? {}
          : { runId: item.currentRunId }),
      });
      return {
        item: updated,
        subagentId: input.subagentId,
        previousStatus,
        ...(reason === undefined ? {} : { reason }),
      };
    });
  }

  async interruptByParent(
    parentSessionId: string,
    reason = "parent run interrupted",
  ): Promise<readonly SubagentInstanceRecord[]> {
    const targets = [...this.active.entries()].filter(
      ([, active]) => active.parentSessionId === parentSessionId,
    );
    const settlements = targets.map(([, active]) => {
      const claim = active.claimCompletion?.promise;
      return (
        active.drainPromise ??
        claim?.then(async () => {
          await active.drainPromise;
        })
      );
    });
    for (const [, active] of targets) {
      active.drainAfterInterrupt = false;
      active.pauseReason = reason;
      active.pauseController.abort(reason);
      active.abortController?.abort(reason);
    }
    await Promise.all(
      settlements.map(async (settlement) => {
        await settlement?.catch(() => undefined);
      }),
    );
    const records = await Promise.all(
      targets.map(([subagentId]) =>
        this.options.store.get({ parentSessionId, subagentId }),
      ),
    );
    return records.filter(
      (record): record is SubagentInstanceRecord => record !== null,
    );
  }

  recoverInterrupted(
    input: Omit<MarkSubagentsInterruptedInput, "interruptedAt"> = {},
  ): Promise<readonly SubagentInstanceRecord[]> {
    return this.options.store.markInterrupted({
      ...input,
      interruptedAt: this.now(),
      ownerId: input.ownerId ?? this.options.ownerId,
      ownerPid: input.ownerPid ?? this.options.ownerPid,
    });
  }

  hasActiveWork(): boolean {
    return (
      this.executionJobs.size > 0 ||
      this.settlingTurns.size > 0 ||
      [...this.active.values()].some(
        (active) =>
          active.running ||
          active.queue.length > 0 ||
          active.pendingSettlement !== undefined,
      )
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const rootRunId of this.rootByExecution.values()) {
      this.sealedRoots.add(rootRunId);
      await this.options.executionStore.interruptRoot(
        rootRunId,
        "subagent host disposed",
        this.now(),
      );
    }
    const activeStates = [...this.active.values()];
    for (const active of activeStates) {
      active.drainAfterInterrupt = false;
      active.stopping = true;
      active.pauseController.abort("subagent host disposed");
      active.abortController?.abort("subagent host disposed");
    }
    await this.markOwnedInterrupted();
    await Promise.all(
      activeStates.map(async (active) => {
        await active.drainPromise?.catch(() => undefined);
      }),
    );
  }

  private async createRecord(
    input: SubagentRunInput,
    execution: SubagentExecutionRecord,
  ): Promise<SubagentInstanceRecord> {
    if (!input.role) {
      throw new Error("role is required when creating a subagent");
    }
    await this.options.agentManager.getRuntimeAgent(input.role, {
      isSubagent: true,
    });
    const parent = await this.options.sessionManager.get(input.parentSessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${input.parentSessionId}`);
    }
    const existing = await this.options.store.listByParent(
      input.parentSessionId,
    );
    const session =
      existing.length === 0
        ? await this.createChildSession(parent, input.role, input.description)
        : await this.getChildSession(
            existing[0].sessionId,
            input.parentSessionId,
          );
    const subagentId = execution.subagentId;
    this.assertRootOpen(execution.rootRunId);
    if (this.closedSubagents.has(subagentId))
      throw new Error("Subagent is closed");
    const now = this.now();
    const record: SubagentInstanceRecord = {
      contextScopeId: subagentId,
      createdAt: now,
      description: input.description,
      initialPrompt: input.prompt,
      name: input.name,
      ownerId: this.options.ownerId,
      ownerPid: this.options.ownerPid,
      parentSessionId: input.parentSessionId,
      pendingQueue: [
        {
          executionId: execution.executionId,
          rootRunId: execution.rootRunId,
          requesterRunId: execution.requesterRunId,
          requesterScopeId: execution.requesterScopeId,
          prompt: input.prompt,
          timeoutMs: input.timeoutMs,
          workdir: input.environment?.workdir,
        },
      ],
      role: input.role,
      sessionId: session.id,
      status: "pending",
      subagentId,
      timeoutMs: input.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
      updatedAt: now,
    };
    await this.options.store.create(record);
    if (
      this.closedSubagents.has(subagentId) ||
      this.sealedRoots.has(execution.rootRunId)
    ) {
      const closed = this.closedSubagents.has(subagentId);
      await this.options.store.update(subagentId, {
        status: closed ? "cancelled" : "interrupted",
        pendingQueue: [],
        ...(closed ? { closedAt: this.now() } : {}),
        updatedAt: this.now(),
      });
      throw new Error(
        closed ? "Subagent is closed" : "Subagent root run is closed",
      );
    }
    return record;
  }

  private async withParentSessionLock<T>(
    parentSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.parentSessionLocks.get(parentSessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.parentSessionLocks.set(parentSessionId, chain);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.parentSessionLocks.get(parentSessionId) === chain) {
        this.parentSessionLocks.delete(parentSessionId);
      }
    }
  }

  private async withSubagentLock<T>(
    subagentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.subagentLocks.get(subagentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.subagentLocks.set(subagentId, chain);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.subagentLocks.get(subagentId) === chain) {
        this.subagentLocks.delete(subagentId);
      }
    }
  }

  private async getExisting(
    input: SubagentRunInput,
  ): Promise<SubagentInstanceRecord> {
    if (!input.subagentId) {
      throw new Error("subagentId is required");
    }
    const record = await this.options.store.get({
      parentSessionId: input.parentSessionId,
      subagentId: input.subagentId,
    });
    if (!record) {
      throw new Error(`Subagent not found: ${input.subagentId}`);
    }
    if (
      record.closedAt !== undefined ||
      this.closedSubagents.has(record.subagentId)
    ) {
      throw new Error(`Subagent is closed: ${input.subagentId}`);
    }
    await this.getChildSession(record.sessionId, record.parentSessionId);
    return record;
  }

  private async createChildSession(
    parent: Session,
    role: SubagentRole,
    description?: string,
  ): Promise<Session> {
    return this.options.sessionManager.create(parent.projectRoot, {
      agentName: role,
      parentId: parent.id,
      title: description,
    });
  }

  private async getChildSession(
    sessionId: string,
    parentSessionId: string,
  ): Promise<Session> {
    const session = await this.options.sessionManager.get(sessionId);
    if (!session) {
      throw new Error(`Subagent session not found: ${sessionId}`);
    }
    if (!session.isSubagent || session.parentId !== parentSessionId) {
      throw new Error(
        `Subagent session parent mismatch: ${sessionId} does not belong to ${parentSessionId}`,
      );
    }
    return session;
  }

  private mustGet(
    parentSessionId: string,
    subagentId: string,
  ): Promise<SubagentInstanceRecord> {
    return this.options.store
      .get({ parentSessionId, subagentId })
      .then((record) => {
        if (!record) {
          throw new Error(`Subagent not found: ${subagentId}`);
        }
        return record;
      });
  }

  private async enqueueOrSchedule(
    record: SubagentInstanceRecord,
    prompt: string,
    environment?: ToolExecutionEnvironment,
    interrupt = false,
    timeoutMs?: number,
    waitForEntry = false,
    signal?: AbortSignal,
    entryAlreadyQueued = false,
    reasoning?: ReasoningIntent,
    execution?: SubagentExecutionRecord,
  ): Promise<EntryOutcome> {
    if (this.disposed) {
      await this.markOwnedInterrupted(record.parentSessionId);
      throw new Error("Subagent host is disposed");
    }
    const completion = waitForEntry
      ? this.createDeferredCompletion()
      : undefined;
    const entry: ActiveQueuedSubagentInput = {
      ...(execution
        ? {
            executionId: execution.executionId,
            rootRunId: execution.rootRunId,
            requesterRunId: execution.requesterRunId,
            requesterScopeId: execution.requesterScopeId,
          }
        : {}),
      ...(reasoning === undefined ? {} : { reasoning }),
      completion,
      environment,
      prompt,
      signal,
      timeoutMs,
      workdir: environment?.workdir,
    };
    const scheduled = await this.withSubagentLock(
      record.subagentId,
      async () => {
        if (this.disposed) {
          await this.markOwnedInterrupted(record.parentSessionId);
          throw new Error("Subagent host is disposed");
        }
        if (execution) this.assertRootOpen(execution.rootRunId);
        const active = this.active.get(record.subagentId);
        if (active && !active.closed && !active.stopping) {
          const persisted = await this.options.store.appendPendingQueue(
            record.subagentId,
            this.serializeInput(entry),
            this.now(),
          );
          if (!persisted) {
            throw new Error(`Subagent is closed: ${record.subagentId}`);
          }
          active.queue.push(entry);
          this.bindQueuedAbort(active, entry);
          if (interrupt && active.running) {
            active.drainAfterInterrupt = true;
            active.abortController?.abort("subagent interrupted");
          }
          return {
            alreadyActive: true as const,
            pendingSettlement: active.pendingSettlement,
          };
        }

        const currentRecord = active
          ? await this.mustGet(record.parentSessionId, record.subagentId)
          : record;
        if (
          currentRecord.status === "running" ||
          currentRecord.currentRunId !== undefined
        ) {
          throw new Error(
            `Subagent is active under another runtime owner: ${record.subagentId}`,
          );
        }

        const persisted = entryAlreadyQueued
          ? currentRecord
          : await this.options.store.appendPendingQueue(
              record.subagentId,
              this.serializeInput(entry),
              this.now(),
            );
        if (!persisted) {
          throw new Error(`Subagent is closed: ${record.subagentId}`);
        }
        const pendingQueue: ActiveQueuedSubagentInput[] = [];
        for (const item of persisted.pendingQueue) {
          if (!item.executionId || this.sealedRoots.has(item.rootRunId ?? ""))
            continue;
          const accepted = await this.options.executionStore.get({
            executionId: item.executionId,
            parentSessionId: record.parentSessionId,
          });
          if (accepted?.status === "queued") pendingQueue.push({ ...item });
        }
        if (pendingQueue.length === 0) {
          throw new Error(
            `Subagent is missing its persisted input: ${record.subagentId}`,
          );
        }
        pendingQueue[pendingQueue.length - 1] = entry;
        const pendingSettlement = this.settlingTurns.get(record.subagentId);
        const scheduledActive = this.createActiveState(
          currentRecord.parentSessionId,
          pendingQueue,
          pendingSettlement,
        );
        const claimCompletion = this.createDeferredClaim();
        scheduledActive.claimCompletion = claimCompletion;
        this.active.set(record.subagentId, scheduledActive);
        if (scheduledActive.queue.length > 1) {
          this.bindQueuedAbort(scheduledActive, entry);
        }
        const drainPromise = Promise.resolve().then(() =>
          this.drainQueue(persisted, scheduledActive),
        );
        scheduledActive.drainPromise = drainPromise;
        void drainPromise.catch(() => undefined);
        return {
          alreadyActive: false as const,
          claimCompletion,
          pendingSettlement,
        };
      },
    );
    if (scheduled.alreadyActive) {
      return await this.awaitCompletionOrGet(
        record.parentSessionId,
        record.subagentId,
        completion,
      );
    }
    if (!waitForEntry && scheduled.pendingSettlement !== undefined) {
      return {
        item: await this.mustGet(record.parentSessionId, record.subagentId),
      };
    }
    await scheduled.claimCompletion.promise;
    return await this.awaitCompletionOrGet(
      record.parentSessionId,
      record.subagentId,
      completion,
    );
  }

  private async drainQueue(
    record: SubagentInstanceRecord,
    active: ActiveSubagentState,
  ): Promise<void> {
    active.running = true;
    let inFlight: ActiveQueuedSubagentInput | undefined;
    try {
      if (active.pendingSettlement !== undefined) {
        const settled = await waitForSettlementOrAbort(
          active.pendingSettlement,
          active.pauseController.signal,
        );
        if (settled) {
          active.pendingSettlement = undefined;
        }
      }
      for (;;) {
        if (this.isActiveClosed(active)) {
          active.claimCompletion?.resolve();
          active.claimCompletion = undefined;
          return;
        }
        if (this.isActiveStopping(active)) {
          active.claimCompletion?.reject(
            new Error(
              `Subagent run stopped before claim: ${record.subagentId}`,
            ),
          );
          active.claimCompletion = undefined;
          return;
        }
        if (this.currentPauseReason(active) !== undefined) {
          active.claimCompletion?.resolve();
          active.claimCompletion = undefined;
          const { pausedForeground, pausedItem } = await this.withSubagentLock(
            record.subagentId,
            async () => {
              active.stopping = true;
              const pausedForeground = this.takePausedForegroundInputs(active);
              const interruptedAt = this.now();
              const pausedItem = await this.options.store.update(
                record.subagentId,
                {
                  completedAt: interruptedAt,
                  error: active.pauseReason,
                  interruptedAt,
                  output: active.pauseReason,
                  pendingQueue: this.serializeQueue(active.queue),
                  status: "interrupted",
                  updatedAt: interruptedAt,
                },
              );
              return { pausedForeground, pausedItem };
            },
          );
          this.resolveQueuedCompletions(pausedForeground, pausedItem, true);
          return;
        }
        let next: ActiveQueuedSubagentInput | undefined;
        let effectiveTimeoutMs: number | undefined;
        let runId: string | undefined;
        let claimed: SubagentInstanceRecord | null | undefined;
        await this.withSubagentLock(record.subagentId, async () => {
          if (
            this.isActiveClosed(active) ||
            active.stopping ||
            active.pauseReason !== undefined
          ) {
            return;
          }
          const queued = active.queue.shift();
          if (!queued) {
            active.stopping = true;
            return;
          }
          queued.unbindQueueAbort?.();
          queued.unbindQueueAbort = undefined;
          if (queued.rootRunId && this.sealedRoots.has(queued.rootRunId))
            return;
          active.currentExecution = queued;
          const timeout = normalizeTimeoutMs(
            queued.timeoutMs ?? record.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
          );
          const nextRunId = this.createRunId();
          const startedAt = this.now();
          if (!queued.executionId || !queued.rootRunId)
            throw new Error("Queued execution identity missing");
          await this.options.executionStore.start(
            {
              executionId: queued.executionId,
              parentSessionId: record.parentSessionId,
            },
            nextRunId,
            startedAt,
          );
          this.assertRootOpen(queued.rootRunId);
          const nextClaim = await this.options.store.claim(record.subagentId, {
            completedAt: undefined,
            currentInput: this.serializeInput(queued),
            currentRunId: nextRunId,
            error: undefined,
            interruptedAt: undefined,
            output: undefined,
            ownerId: this.options.ownerId,
            ownerPid: this.options.ownerPid,
            pendingQueue: this.serializeQueue(active.queue),
            startedAt,
            status: "running",
            updatedAt: startedAt,
          });
          if (!nextClaim) {
            throw new Error(
              `Subagent run claim rejected: ${record.subagentId}`,
            );
          }
          next = queued;
          effectiveTimeoutMs = timeout;
          runId = nextRunId;
          claimed = nextClaim;
        });
        if (this.isActiveClosed(active)) {
          return;
        }
        if (this.isActiveStopping(active)) {
          active.claimCompletion?.reject(
            new Error(
              `Subagent run stopped before claim: ${record.subagentId}`,
            ),
          );
          active.claimCompletion = undefined;
          return;
        }
        if (!next) {
          active.claimCompletion?.resolve();
          active.claimCompletion = undefined;
          return;
        }
        if (!claimed || runId === undefined) {
          throw new Error(`Subagent run claim rejected: ${record.subagentId}`);
        }
        inFlight = next;
        active.claimCompletion?.resolve();
        active.claimCompletion = undefined;
        const pauseReason = this.currentPauseReason(active);
        const item =
          pauseReason === undefined
            ? await this.runTurn(
                record,
                next,
                active,
                runId,
                effectiveTimeoutMs,
              )
            : await this.finishInterruptedRun(record, runId, pauseReason);
        next.completion?.resolve({ item });
        active.currentExecution = undefined;
        inFlight = undefined;
        const drainAfterInterrupt = active.drainAfterInterrupt;
        const lastRunSettled = active.lastRunSettled;
        active.drainAfterInterrupt = false;
        if (this.isActiveClosed(active)) {
          return;
        }
        if (item.status === "completed") {
          continue;
        }
        if (
          item.status === "interrupted" &&
          drainAfterInterrupt &&
          lastRunSettled
        ) {
          continue;
        }
        const { pausedForeground, pausedItem } = await this.withSubagentLock(
          record.subagentId,
          async () => {
            active.stopping = true;
            const pausedForeground = this.takePausedForegroundInputs(active);
            const pausedItem = await this.options.store.update(
              record.subagentId,
              {
                pendingQueue: this.serializeQueue(active.queue),
                updatedAt: this.now(),
              },
            );
            return { pausedForeground, pausedItem };
          },
        );
        this.resolveQueuedCompletions(pausedForeground, pausedItem, true);
        return;
      }
    } catch (error) {
      active.claimCompletion?.reject(error);
      active.claimCompletion = undefined;
      inFlight?.unbindQueueAbort?.();
      inFlight?.completion?.reject(error);
      if (
        active.currentExecution?.executionId &&
        active.currentExecution.rootRunId &&
        !(error instanceof SubagentPersistenceError)
      ) {
        await this.finishExecution(
          {
            executionId: active.currentExecution.executionId,
            parentSessionId: record.parentSessionId,
            rootRunId: active.currentExecution.rootRunId,
          },
          {
            status: "failed",
            error: errorMessage(error),
            completedAt: this.now(),
          },
        );
      }
      for (const queued of active.queue.splice(0)) {
        queued.unbindQueueAbort?.();
        queued.completion?.reject(error);
      }
      throw error;
    } finally {
      active.abortController = undefined;
      active.running = false;
      if (this.active.get(record.subagentId) === active) {
        this.active.delete(record.subagentId);
      }
    }
  }

  private async runTurn(
    record: SubagentInstanceRecord,
    input: ActiveQueuedSubagentInput,
    active: ActiveSubagentState,
    runId: string,
    effectiveTimeoutMs: number | undefined,
  ): Promise<SubagentInstanceRecord> {
    const deadlineReason =
      effectiveTimeoutMs === undefined
        ? undefined
        : timeoutMessage(effectiveTimeoutMs);
    this.active.set(record.subagentId, active);
    if (this.isActiveClosed(active) || active.stopping) {
      return await this.mustGet(record.parentSessionId, record.subagentId);
    }
    const abortController = new AbortController();
    active.abortController = abortController;
    const parentSignal = input.signal;
    const abort = (): void => {
      abortController.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) {
      abort();
    } else {
      parentSignal?.addEventListener("abort", abort, { once: true });
    }
    const deadline =
      effectiveTimeoutMs === undefined
        ? undefined
        : createDeadlineController({
            parent: abortController.signal,
            reason: timeoutMessage(effectiveTimeoutMs),
            timeoutMs: effectiveTimeoutMs,
          });
    const turnSignal = deadline?.signal ?? abortController.signal;
    const timedOut = (): boolean => deadline?.didTimeout() === true;
    const interrupted = (): boolean =>
      abortController.signal.aborted && !timedOut();
    const persist = async (
      update: Parameters<SubagentInstanceStore["finishRun"]>[2],
      reason?: string,
    ): Promise<SubagentInstanceRecord> => {
      if (!input.executionId || !input.rootRunId)
        throw new Error("Running execution identity missing");
      const terminal = await this.finishExecution(
        {
          executionId: input.executionId,
          parentSessionId: record.parentSessionId,
          rootRunId: input.rootRunId,
        },
        {
          status: update.status as ExecutionTerminalResult["status"],
          output: update.status === "completed" ? update.output : undefined,
          error: update.error,
          reason,
          completedAt: update.completedAt ?? this.now(),
        },
      );
      try {
        return await this.options.store.finishRun(record.subagentId, runId, {
          ...update,
          status: terminal.status as SubagentInstanceRecord["status"],
          output: terminal.output ?? terminal.error,
          error: terminal.error,
        });
      } catch (error) {
        this.sealedRoots.add(input.rootRunId);
        const failure = new SubagentPersistenceError(errorMessage(error));
        this.options.onFatal?.(failure, input.rootRunId);
        throw failure;
      }
    };
    const markTimedOut = (): Promise<SubagentInstanceRecord> =>
      persist({
        completedAt: this.now(),
        currentInput: undefined,
        currentRunId: undefined,
        error: deadlineReason,
        lastRunId: runId,
        output: deadlineReason,
        status: "timed_out",
        updatedAt: this.now(),
      });
    const markInterrupted = (): Promise<SubagentInstanceRecord> =>
      persist(
        {
          completedAt: this.now(),
          currentInput: undefined,
          currentRunId: undefined,
          lastRunId: runId,
          error: errorMessage(turnSignal.reason ?? "subagent interrupted"),
          status: "interrupted",
          updatedAt: this.now(),
        },
        "cancelled",
      );

    try {
      const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
        record.role,
        { isSubagent: true },
      );
      if (this.isActiveClosed(active) || this.isActiveStopping(active)) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      const session = await this.getChildSession(
        record.sessionId,
        record.parentSessionId,
      );
      const instance = this.options.instanceFactory.create({
        agentName: record.role,
        contextScopeId: record.contextScopeId,
        instanceId: record.subagentId,
        maxSteps: runtimeAgent.config.maxSteps,
        modelId: runtimeAgent.config.model ?? this.options.modelId,
        parentSessionId: record.parentSessionId,
        projectRoot: session.projectRoot,
        sessionId: record.sessionId,
        type: "sub",
      });
      if (input.rootRunId) this.assertRootOpen(input.rootRunId);
      if (turnSignal.aborted) return await markInterrupted();
      active.lastRunSettled = false;
      let turnPromise: Promise<AgentRunResult>;
      try {
        turnPromise = instance.turn({
          ...(input.reasoning === undefined
            ? {}
            : { reasoning: input.reasoning }),
          environment: input.environment,
          prompt: input.prompt,
          runId,
          signal: turnSignal,
          waitMode: "waitForCompletion",
          workdir: input.workdir,
        });
      } catch (error) {
        active.lastRunSettled = true;
        throw error;
      }
      void turnPromise
        .then(async (result) => {
          if (!turnSignal.aborted || !input.executionId || !input.rootRunId)
            return;
          const saved = await this.options.executionStore.get({
            executionId: input.executionId,
            parentSessionId: record.parentSessionId,
          });
          if (!saved || saved.status === "queued" || saved.status === "running")
            return;
          const late = successfulOutput(result);
          await this.finishExecution(
            {
              executionId: input.executionId,
              parentSessionId: record.parentSessionId,
              rootRunId: input.rootRunId,
            },
            {
              status: late.status,
              output: late.success ? late.output : undefined,
              error: late.success ? undefined : late.output,
              reason:
                result.mode === "waitForCompletion"
                  ? result.terminalReason
                  : undefined,
              completedAt: this.now(),
            },
          );
        })
        .catch(() => undefined);
      const settlement = turnPromise.then(
        () => {
          active.lastRunSettled = true;
        },
        () => {
          active.lastRunSettled = true;
        },
      );
      const trackSettlement = (): void => {
        if (!active.lastRunSettled) {
          this.trackSettlingTurn(record.subagentId, settlement);
        }
      };
      const turn = await waitForTurnOrAbort(turnPromise, turnSignal);
      if (this.isActiveClosed(active)) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      if (timedOut()) {
        trackSettlement();
        return await markTimedOut();
      }
      if (interrupted()) {
        trackSettlement();
        return await markInterrupted();
      }
      if (turn.kind === "aborted") {
        trackSettlement();
        return await markInterrupted();
      }
      const result = turn.result;
      const { output, success, status } = successfulOutput(result);
      return await persist(
        {
          completedAt: this.now(),
          currentInput: undefined,
          currentRunId: undefined,
          error: success ? undefined : output,
          lastRunId: result.runId ?? runId,
          output,
          status,
          updatedAt: this.now(),
        },
        result.mode === "waitForCompletion" ? result.terminalReason : undefined,
      );
    } catch (error) {
      if (error instanceof SubagentPersistenceError) throw error;
      if (this.isActiveClosed(active)) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      if (timedOut()) {
        return await markTimedOut();
      }
      if (interrupted()) {
        return await markInterrupted();
      }
      return await persist({
        completedAt: this.now(),
        currentInput: undefined,
        currentRunId: undefined,
        error: errorMessage(error),
        lastRunId: runId,
        output: errorMessage(error),
        status: "failed",
        updatedAt: this.now(),
      });
    } finally {
      deadline?.dispose();
      parentSignal?.removeEventListener("abort", abort);
      active.abortController = undefined;
    }
  }

  private createActiveState(
    parentSessionId: string,
    queue: readonly ActiveQueuedSubagentInput[] = [],
    pendingSettlement?: Promise<void>,
  ): ActiveSubagentState {
    return {
      closed: false,
      drainAfterInterrupt: false,
      lastRunSettled: true,
      ...(pendingSettlement === undefined ? {} : { pendingSettlement }),
      parentSessionId,
      pauseController: new AbortController(),
      queue: [...queue],
      running: false,
      stopping: false,
    };
  }

  private isActiveClosed(active: ActiveSubagentState): boolean {
    return active.closed;
  }

  private isActiveStopping(active: ActiveSubagentState): boolean {
    return active.stopping;
  }

  private currentPauseReason(active: ActiveSubagentState): string | undefined {
    return active.pauseReason;
  }

  private trackSettlingTurn(
    subagentId: string,
    settlement: Promise<void>,
  ): void {
    this.settlingTurns.set(subagentId, settlement);
    void settlement.then(() => {
      if (this.settlingTurns.get(subagentId) === settlement) {
        this.settlingTurns.delete(subagentId);
      }
    });
  }

  private resolveQueuedCompletions(
    queue: readonly ActiveQueuedSubagentInput[],
    item: SubagentInstanceRecord,
    paused?: true,
  ): void {
    for (const queued of queue) {
      queued.unbindQueueAbort?.();
      queued.completion?.resolve({ item, ...(paused ? { paused } : {}) });
    }
  }

  private takePausedForegroundInputs(
    active: ActiveSubagentState,
  ): ActiveQueuedSubagentInput[] {
    const paused: ActiveQueuedSubagentInput[] = [];
    const retained: ActiveQueuedSubagentInput[] = [];
    for (const queued of active.queue) {
      if (!queued.completion) {
        retained.push(queued);
        continue;
      }
      queued.unbindQueueAbort?.();
      queued.unbindQueueAbort = undefined;
      paused.push(queued);
      retained.push(this.detachQueuedInput(queued));
    }
    active.queue = retained;
    return paused;
  }

  private bindQueuedAbort(
    active: ActiveSubagentState,
    input: ActiveQueuedSubagentInput,
  ): void {
    const signal = input.signal;
    if (!signal) {
      return;
    }
    const onAbort = (): void => {
      const index = active.queue.indexOf(input);
      if (index < 0) {
        return;
      }
      active.queue[index] = this.detachQueuedInput(input);
      input.unbindQueueAbort?.();
      input.unbindQueueAbort = undefined;
      const reason = errorMessage(
        signal.reason ?? "queued subagent caller stopped waiting",
      );
      input.completion?.reject(new Error(reason));
    };
    input.unbindQueueAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private detachQueuedInput(
    input: ActiveQueuedSubagentInput,
  ): ActiveQueuedSubagentInput {
    return {
      executionId: input.executionId,
      rootRunId: input.rootRunId,
      requesterRunId: input.requesterRunId,
      requesterScopeId: input.requesterScopeId,
      ...(input.environment === undefined
        ? {}
        : { environment: input.environment }),
      prompt: input.prompt,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
    };
  }

  private finishInterruptedRun(
    record: SubagentInstanceRecord,
    runId: string,
    reason: string,
  ): Promise<SubagentInstanceRecord> {
    const interruptedAt = this.now();
    return this.options.store.finishRun(record.subagentId, runId, {
      completedAt: interruptedAt,
      currentInput: undefined,
      currentRunId: undefined,
      error: reason,
      interruptedAt,
      lastRunId: runId,
      output: reason,
      status: "interrupted",
      updatedAt: interruptedAt,
    });
  }

  private serializeQueue(
    queue: readonly ActiveQueuedSubagentInput[],
  ): QueuedSubagentInput[] {
    return queue.map((input) => this.serializeInput(input));
  }

  private serializeInput(
    input: ActiveQueuedSubagentInput,
  ): QueuedSubagentInput {
    const {
      reasoning: _reasoning,
      completion: _completion,
      environment,
      signal: _signal,
      unbindQueueAbort: _unbindQueueAbort,
      ...item
    } = input;
    return {
      ...item,
      workdir: item.workdir ?? environment?.workdir,
    };
  }

  private createDeferredCompletion(): DeferredCompletion {
    let resolve!: (outcome: EntryOutcome) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<EntryOutcome>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    void promise.catch(() => undefined);
    return { promise, reject, resolve };
  }

  private createDeferredClaim(): DeferredClaim {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    return { promise, reject, resolve };
  }

  private markOwnedInterrupted(
    parentSessionId?: string,
  ): Promise<readonly SubagentInstanceRecord[]> {
    return this.options.store.markInterrupted({
      parentSessionId,
      interruptedAt: this.now(),
      ownerId: this.options.ownerId,
      ownerPid: this.options.ownerPid,
      recoverUnknownOwner:
        this.options.ownerId === undefined &&
        this.options.ownerPid === undefined,
    });
  }

  private async awaitCompletionOrGet(
    parentSessionId: string,
    subagentId: string,
    completion: DeferredCompletion | undefined,
  ): Promise<EntryOutcome> {
    if (!completion) {
      return { item: await this.mustGet(parentSessionId, subagentId) };
    }
    return await completion.promise;
  }
}

class SubagentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentPersistenceError";
  }
}
