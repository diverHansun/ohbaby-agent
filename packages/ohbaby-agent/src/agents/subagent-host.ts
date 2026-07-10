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
  readonly completion?: DeferredCompletion;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
  unbindQueueAbort?: () => void;
}

interface DeferredCompletion {
  readonly promise: Promise<SubagentInstanceRecord>;
  reject(error: unknown): void;
  resolve(record: SubagentInstanceRecord): void;
}

interface DeferredClaim {
  readonly promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
}

export interface SessionSubagentHostOptions {
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

const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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
} {
  if (result.mode !== "waitForCompletion") {
    return {
      output: "Subagent expected a completed agent run",
      success: false,
    };
  }
  return result.success
    ? { output: result.finalOutput, success: true }
    : { output: result.error, success: false };
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("subagent timeoutMs must be a positive number");
  }
  if (timeoutMs > MAX_SUBAGENT_TIMEOUT_MS) {
    throw new Error("subagent timeoutMs must not exceed 7200000ms");
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

  constructor(private readonly options: SessionSubagentHostOptions) {
    this.createSubagentId = options.createSubagentId ?? defaultSubagentId;
    this.createRunId = options.createRunId ?? defaultRunId;
    this.now = options.now ?? Date.now;
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    if (this.disposed) {
      throw new Error("Subagent host is disposed");
    }
    const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
    const isNew = input.subagentId === undefined;
    const record = isNew
      ? await this.withParentSessionLock(input.parentSessionId, () =>
          this.createRecord({ ...input, timeoutMs }),
        )
      : await this.getExisting(input);
    if (input.mode === "background") {
      await this.enqueueOrSchedule(
        record,
        input.prompt,
        input.environment,
        input.interrupt === true,
        timeoutMs,
        false,
        undefined,
        isNew,
      );
      return {
        item: await this.mustGet(record.parentSessionId, record.subagentId),
      };
    }

    const item = await this.enqueueOrSchedule(
      record,
      input.prompt,
      input.environment,
      input.interrupt === true,
      timeoutMs,
      true,
      input.signal,
      isNew,
    );
    return {
      item,
      output: item.output,
      success: item.status === "completed",
    };
  }

  async status(input: SubagentStatusInput): Promise<SubagentStatusResult> {
    if (input.subagentId) {
      const item = await this.options.store.get({
        parentSessionId: input.parentSessionId,
        subagentId: input.subagentId,
      });
      return { items: item ? [item] : [] };
    }
    return {
      items: await this.options.store.listByParent(input.parentSessionId),
    };
  }

  async close(input: SubagentLookupInput): Promise<SubagentCloseResult> {
    return this.withSubagentLock(input.subagentId, async () => {
      const item = await this.mustGet(input.parentSessionId, input.subagentId);
      const previousStatus = item.status;
      const active = this.active.get(input.subagentId);
      const queued = active?.queue.splice(0) ?? [];
      if (active) {
        active.closed = true;
        active.pauseController.abort("subagent closed");
        active.abortController?.abort("subagent closed");
      }
      const closedAt = this.now();
      const updated = await this.options.store.update(input.subagentId, {
        closedAt,
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
      return { item: updated, previousStatus };
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

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
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
    const subagentId = this.createSubagentId();
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
    if (record.closedAt !== undefined) {
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
  ): Promise<SubagentInstanceRecord> {
    if (this.disposed) {
      await this.markOwnedInterrupted(record.parentSessionId);
      throw new Error("Subagent host is disposed");
    }
    const completion = waitForEntry
      ? this.createDeferredCompletion()
      : undefined;
    const entry: ActiveQueuedSubagentInput = {
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
        const pendingQueue = persisted.pendingQueue.map((item) => ({
          ...item,
        }));
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
      return await this.mustGet(record.parentSessionId, record.subagentId);
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
          this.resolveQueuedCompletions(pausedForeground, pausedItem);
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
          const timeout = normalizeTimeoutMs(
            queued.timeoutMs ?? record.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
          );
          const nextRunId = this.createRunId();
          const startedAt = this.now();
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
        next.completion?.resolve(item);
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
        this.resolveQueuedCompletions(pausedForeground, pausedItem);
        return;
      }
    } catch (error) {
      active.claimCompletion?.reject(error);
      active.claimCompletion = undefined;
      inFlight?.unbindQueueAbort?.();
      inFlight?.completion?.reject(error);
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
    const markTimedOut = (): Promise<SubagentInstanceRecord> =>
      this.options.store.finishRun(record.subagentId, runId, {
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
      this.finishInterruptedRun(
        record,
        runId,
        errorMessage(turnSignal.reason ?? "subagent interrupted"),
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
        modelId: this.options.modelId,
        parentSessionId: record.parentSessionId,
        projectRoot: session.projectRoot,
        sessionId: record.sessionId,
        type: "sub",
      });
      active.lastRunSettled = false;
      let turnPromise: Promise<AgentRunResult>;
      try {
        turnPromise = instance.turn({
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
      const { output, success } = successfulOutput(result);
      return await this.options.store.finishRun(record.subagentId, runId, {
        completedAt: this.now(),
        currentInput: undefined,
        currentRunId: undefined,
        error: success ? undefined : output,
        lastRunId: result.runId ?? runId,
        output,
        status: success ? "completed" : "failed",
        updatedAt: this.now(),
      });
    } catch (error) {
      if (this.isActiveClosed(active)) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      if (timedOut()) {
        return await markTimedOut();
      }
      if (interrupted()) {
        return await markInterrupted();
      }
      return await this.options.store.finishRun(record.subagentId, runId, {
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
  ): void {
    for (const queued of queue) {
      queued.unbindQueueAbort?.();
      queued.completion?.resolve(item);
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
    let resolve!: (record: SubagentInstanceRecord) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SubagentInstanceRecord>(
      (innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
      },
    );
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
  ): Promise<SubagentInstanceRecord> {
    if (!completion) {
      return await this.mustGet(parentSessionId, subagentId);
    }
    return await completion.promise;
  }
}
