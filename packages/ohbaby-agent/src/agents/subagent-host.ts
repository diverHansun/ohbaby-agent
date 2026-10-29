import type { RunModel } from "../core/run-model.js";
import { SubagentExecutionConflictError } from "./subagents/execution-store.js";
import { createHash } from "node:crypto";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
  ExecutionTerminalResult,
} from "./subagents/execution-store.js";
import { mergeReasoningIntent, type ReasoningIntent } from "ohbaby-llm";
import type {
  AgentInstanceFactory,
  AgentRunResult,
} from "../core/agents/index.js";
import type { ToolExecutionEnvironment } from "../core/tool-scheduler/index.js";
import type { Session, SessionManager } from "../services/session/index.js";
import {
  createApprovalAwareDeadline,
  type ExecutionBudgetSnapshot,
} from "./subagents/execution-budget.js";
import type { AgentManager } from "./manager.js";
import { assertNoStaticModelConfig } from "./types.js";
import type { SubagentRole } from "./roles.js";
import type {
  SubagentMonitorInput,
  SubagentMonitorResult,
} from "./subagents/monitor.js";
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
  SubagentSpawnInput,
  SubagentSendInput,
  SubagentStartResult,
  SubagentStopInput,
  SubagentStopResult,
  SubagentUnprocessedMessage,
  SubagentCleanupResult,
} from "./subagents/index.js";

interface ExecutionLease {
  readonly executionId: string;
  readonly subagentId: string;
  readonly parentSessionId: string;
  readonly controller: AbortController;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly cleaned: Promise<void>;
  readonly resolveCleaned: () => void;
  execution?: SubagentExecutionRecord;
  stopReason?: string;
  closing?: boolean;
  cleaning?: Promise<void>;
  scopeCleanup?: Promise<SubagentCleanupResult>;
  unprocessedMessages: readonly SubagentUnprocessedMessage[];
}

interface ActiveSubagentState {
  abortController?: AbortController;
  currentExecution?: ActiveExecutionInput;
  closed: boolean;
  drainPromise?: Promise<void>;
  lastRunSettled: boolean;
  readonly parentSessionId: string;
  readonly pauseController: AbortController;
  pauseReason?: string;
  running: boolean;
  stopping: boolean;
}

interface ActiveExecutionInput extends QueuedSubagentInput {
  readonly runModel?: RunModel;
  readonly reasoning?: ReasoningIntent;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
}

interface EntryOutcome {
  readonly item: SubagentInstanceRecord;
  readonly paused?: true;
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
  readonly collectExecutionFacts?: (
    execution: SubagentExecutionRecord,
  ) => Promise<import("./subagents/execution-facts.js").ExecutionFactView>;
  readonly ensureResultArtifact?: (
    execution: SubagentExecutionRecord,
  ) => Promise<void>;
  readonly isApprovalBlocked?: (
    executionId: string,
    parentSessionId: string,
  ) => Promise<boolean>;
  readonly subscribeExecution?: (
    sessionId: string,
    runId: string,
    wake: () => void,
  ) => () => void;
  readonly onFatal?: (error: Error, rootRunId: string) => void;
  readonly getParentReasoning?: (
    sessionId: string,
    contextScopeId?: string,
  ) => ReasoningIntent | undefined;
  readonly agentManager: Pick<AgentManager, "getRuntimeAgent">;
  readonly instanceFactory: AgentInstanceFactory;
  readonly getParentRunModel: (
    sessionId: string,
    contextScopeId?: string,
  ) => RunModel | Promise<RunModel>;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly store: SubagentInstanceStore;
  readonly createSubagentId?: () => string;
  readonly createRunId?: () => string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly now?: () => number;
  readonly cleanupWaitMs?: number;
  readonly acceptExecutionMessage?: (input: {
    readonly execution: SubagentExecutionRecord;
    readonly message: string;
    readonly inputId: string;
  }) => Promise<{ readonly accepted: boolean }>;
  readonly getExecutionMessage?: (input: {
    readonly parentSessionId: string;
    readonly subagentId: string;
    readonly inputId: string;
  }) => Promise<{ readonly execution: SubagentExecutionRecord } | undefined>;
  readonly closeExecutionInputs?: (input: {
    readonly execution: SubagentExecutionRecord;
    readonly reason: string;
  }) => Promise<readonly SubagentUnprocessedMessage[]>;
  readonly readExecutionInputs?: (input: {
    readonly execution: SubagentExecutionRecord;
  }) => Promise<readonly SubagentUnprocessedMessage[]>;
  readonly cleanupExecution?: (input: {
    readonly execution: SubagentExecutionRecord;
    readonly reason: string;
  }) => Promise<SubagentCleanupResult>;
  readonly readHistory?: (
    input: SubagentMonitorInput,
  ) => Promise<SubagentMonitorResult>;
  readonly onClosed?: (input: {
    readonly contextScopeId: string;
    readonly runId?: string;
    readonly sessionId: string;
    readonly subagentId: string;
  }) => SubagentCleanupResult | Promise<SubagentCleanupResult>;
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

export class SessionSubagentHost {
  private readonly leases = new Map<string, ExecutionLease>();
  private readonly unprocessed = new Map<
    string,
    readonly SubagentUnprocessedMessage[]
  >();
  private readonly closeOperations = new Map<
    string,
    Promise<SubagentCloseResult>
  >();
  private readonly closingScopes = new Map<
    string,
    Promise<SubagentCleanupResult>
  >();
  private readonly active = new Map<string, ActiveSubagentState>();
  private readonly parentSessionLocks = new Map<string, Promise<void>>();
  private readonly subagentLocks = new Map<string, Promise<void>>();
  private readonly settlingTurns = new Map<string, Promise<void>>();
  private readonly createSubagentId: () => string;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private disposed = false;
  private readonly sealedRoots = new Set<string>();
  private readonly sealedParents = new Set<string>();
  private readonly closedSubagents = new Set<string>();
  private readonly invocationLocks = new Map<string, Promise<void>>();
  /** Orders acceptance through queue admission without waiting for child turns. */
  private readonly admissionTails = new Map<string, Promise<void>>();
  private readonly executionJobs = new Map<string, Promise<EntryOutcome>>();
  private readonly rootByExecution = new Map<string, string>();
  private readonly executionBudgets = new Map<
    string,
    () => ExecutionBudgetSnapshot
  >();

  getExecutionBudget(executionId: string): ExecutionBudgetSnapshot | undefined {
    return this.executionBudgets.get(executionId)?.();
  }

  constructor(private readonly options: SessionSubagentHostOptions) {
    this.createSubagentId = options.createSubagentId ?? defaultSubagentId;
    this.createRunId = options.createRunId ?? defaultRunId;
    this.now = options.now ?? Date.now;
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const result =
      input.subagentId === undefined
        ? await this.spawn(input)
        : await this.send({ ...input, subagentId: input.subagentId });
    if (!result.execution) throw new Error(result.reason);
    return result;
  }

  spawn(input: SubagentSpawnInput): Promise<SubagentStartResult> {
    return this.launch(input);
  }

  async send(input: SubagentSendInput): Promise<SubagentStartResult> {
    if (this.sealedParents.has(input.parentSessionId))
      throw new Error("Subagent parent session is closed");
    if (this.disposed) throw new Error("Subagent host is disposed");
    for (const identity of [
      input.requesterRunId,
      input.requesterMessageId,
      input.requestId,
    ]) {
      if (typeof identity !== "string" || !identity.trim())
        throw new Error("Subagent requester identity is required");
    }
    await this.options.resolveRequester(input);
    const inputId = this.messageInputId(input);
    const receipt = await this.options.getExecutionMessage?.({
      parentSessionId: input.parentSessionId,
      subagentId: input.subagentId,
      inputId,
    });
    if (receipt) {
      await this.getExisting(input);
      if (!this.options.acceptExecutionMessage)
        throw new Error("Execution message input is unavailable");
      const replay = await this.options.acceptExecutionMessage({
        execution: receipt.execution,
        inputId,
        message: input.prompt,
      });
      if (!replay.accepted)
        throw new Error("Saved execution message could not be verified");
      return {
        started: false,
        accepted: true,
        inputId,
        execution: receipt.execution,
      };
    }
    const lease = this.leaseFor(input.parentSessionId, input.subagentId);
    if (lease) return this.deliverMessage(input, lease);
    await this.getExisting(input);
    return this.launch(input);
  }

  private async launch(input: SubagentRunInput): Promise<SubagentStartResult> {
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
    this.assertRootOpen(root.rootRunId, input.parentSessionId);
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
    let lease: ExecutionLease | undefined;
    try {
      this.assertRootOpen(root.rootRunId, input.parentSessionId);
      const prior = await this.executionWrite(root.rootRunId, () =>
        this.options.executionStore.get(lookup),
      );
      const existing =
        input.subagentId === undefined || prior !== null
          ? undefined
          : await this.getExisting(input);
      if (!prior && input.subagentId) {
        const activeLease = this.leaseFor(
          input.parentSessionId,
          input.subagentId,
        );
        if (activeLease)
          return await this.deliverMessage(
            { ...input, subagentId: input.subagentId },
            activeLease,
          );
      }
      const timeoutMs =
        requestedTimeout ??
        Math.min(
          prior?.timeoutMs ??
            existing?.timeoutMs ??
            DEFAULT_SUBAGENT_TIMEOUT_MS,
          MAX_SUBAGENT_TIMEOUT_MS,
        );
      this.assertRootOpen(root.rootRunId, input.parentSessionId);
      if (!prior) {
        const count = [...this.leases.values()].filter(
          (entry) => entry.parentSessionId === input.parentSessionId,
        ).length;
        if (count >= 6)
          return {
            started: false,
            reason:
              "All six subagent execution slots are occupied; this execution was not started.",
          };
        lease = this.reserveExecution(
          executionId,
          input.subagentId ?? this.createSubagentId(),
          input.parentSessionId,
        );
      }
      const acceptedSubagentId =
        input.subagentId ?? prior?.subagentId ?? lease?.subagentId;
      if (!acceptedSubagentId)
        throw new Error("Subagent execution reservation is missing");
      const accepted = await this.executionWrite(root.rootRunId, () =>
        this.options.executionStore.accept({
          ...lookup,
          ...root,
          requesterRunId: input.requesterRunId,
          requestId,
          subagentId: acceptedSubagentId,
          mode: input.mode,
          prompt: input.prompt,
          timeoutMs,
          createdAt: this.now(),
        }),
      );
      execution = accepted.record;
      if (lease) lease.execution = execution;
      if (accepted.created)
        this.rootByExecution.set(executionId, root.rootRunId);
      if (
        this.sealedRoots.has(root.rootRunId) ||
        this.sealedParents.has(input.parentSessionId) ||
        lease?.controller.signal.aborted
      ) {
        await this.options.executionStore.interruptRoot(
          root.rootRunId,
          "parent run interrupted",
          this.now(),
        );
        throw new Error("Subagent root run is closed");
      }
      if (accepted.created) {
        const previousAdmission = this.admissionTails.get(execution.subagentId);
        let resolveAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
          resolveAdmission = resolve;
        });
        this.admissionTails.set(execution.subagentId, admission);
        let admitted = false;
        const releaseAdmission = (): void => {
          if (admitted) return;
          admitted = true;
          resolveAdmission();
          if (this.admissionTails.get(execution.subagentId) === admission)
            this.admissionTails.delete(execution.subagentId);
        };
        const inherited = this.options.getParentReasoning?.(
          input.parentSessionId,
          input.parentContextScopeId,
        );
        const inheritedModel = this.options.getParentRunModel(
          input.parentSessionId,
          input.parentContextScopeId,
        );
        // Admission can wait behind another child; observe resolution failures immediately.
        void Promise.resolve(inheritedModel).catch(() => undefined);
        const job = Promise.resolve().then(async () => {
          await previousAdmission;
          try {
            this.assertRootOpen(root.rootRunId, input.parentSessionId);
            const record =
              existing ??
              (await this.withParentSessionLock(input.parentSessionId, () =>
                this.createRecord(
                  { ...input, subagentId: execution.subagentId, timeoutMs },
                  execution,
                ),
              ));
            this.assertRootOpen(root.rootRunId, input.parentSessionId);
            if (this.closedSubagents.has(execution.subagentId))
              throw new Error("Subagent is closed");
            await this.executionWrite(root.rootRunId, () =>
              this.options.executionStore.bindChild(
                lookup,
                {
                  sessionId: record.sessionId,
                  contextScopeId: record.contextScopeId,
                },
                this.now(),
              ),
            );
            this.assertRootOpen(root.rootRunId, input.parentSessionId);
            return await this.enqueueOrSchedule(
              record,
              input.prompt,
              input.environment,
              input.interrupt === true,
              timeoutMs,
              true,
              lease?.controller.signal,
              existing === undefined,
              inherited === undefined
                ? undefined
                : mergeReasoningIntent(inherited),
              execution,
              releaseAdmission,
              await inheritedModel,
            );
          } catch (error) {
            releaseAdmission();
            if (
              !(error instanceof SubagentPersistenceError) &&
              !(
                input.mode === "foreground" &&
                input.signal?.aborted &&
                !this.sealedRoots.has(root.rootRunId)
              )
            ) {
              await this.finishExecution(execution, {
                status:
                  this.sealedRoots.has(root.rootRunId) ||
                  this.sealedParents.has(input.parentSessionId)
                    ? "interrupted"
                    : "failed",
                error: errorMessage(error),
                reason: errorMessage(error),
                completedAt: this.now(),
              });
            }
            throw error;
          } finally {
            releaseAdmission();
          }
        });
        this.executionJobs.set(executionId, job);
        if (lease && input.mode === "foreground") {
          const currentLease = lease;
          const abort = (): void => {
            currentLease.stopReason = "stopped";
            currentLease.controller.abort(input.signal?.reason);
          };
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener("abort", abort, { once: true });
          void job
            .finally(() => input.signal?.removeEventListener("abort", abort))
            .catch(() => undefined);
        }
        void job
          .catch(() => undefined)
          .finally(() => {
            if (this.executionJobs.get(executionId) === job)
              this.executionJobs.delete(executionId);
            if (lease) this.beginCleanup(lease);
          });
      }
    } catch (error) {
      if (lease) this.beginCleanup(lease);
      throw error;
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
      return { started: true, execution: receipt };
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
      started: true,
      execution: result,
      ...(item ? { item } : {}),
      ...(outcome?.paused ? { paused: true } : {}),
      output: result.output ?? result.error,
      success: result.status === "completed",
    };
  }

  private leaseFor(
    parentSessionId: string,
    subagentId: string,
  ): ExecutionLease | undefined {
    return [...this.leases.values()].find(
      (lease) =>
        lease.parentSessionId === parentSessionId &&
        lease.subagentId === subagentId,
    );
  }

  private reserveExecution(
    executionId: string,
    subagentId: string,
    parentSessionId: string,
  ): ExecutionLease {
    let resolveReady!: () => void;
    let resolveCleaned!: () => void;
    const lease: ExecutionLease = {
      executionId,
      subagentId,
      parentSessionId,
      controller: new AbortController(),
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
      resolveReady: () => {
        resolveReady();
      },
      cleaned: new Promise<void>((resolve) => {
        resolveCleaned = resolve;
      }),
      resolveCleaned: () => {
        resolveCleaned();
      },
      unprocessedMessages: [],
    };
    this.leases.set(executionId, lease);
    return lease;
  }

  private async deliverMessage(
    input: SubagentSendInput,
    lease: ExecutionLease,
  ): Promise<SubagentStartResult> {
    if (lease.closing || this.closedSubagents.has(input.subagentId))
      throw new Error(`Subagent is closed: ${input.subagentId}`);
    if (lease.stopReason)
      return {
        started: false,
        reason:
          "The previous execution is still cleaning up; this message was not accepted.",
      };
    await lease.ready;
    const execution = await this.options.executionStore.get({
      executionId: lease.executionId,
      parentSessionId: input.parentSessionId,
    });
    if (!execution) throw new Error("Accepted subagent execution disappeared");
    if (
      lease.controller.signal.aborted ||
      this.closedSubagents.has(lease.subagentId)
    )
      return {
        started: false,
        reason:
          "The execution was stopped before the message could be accepted.",
      };
    const inputId = this.messageInputId(input);
    if (execution.status === "queued" || execution.status === "running") {
      if (!this.options.acceptExecutionMessage)
        throw new Error("Subagent message input channel is unavailable");
      const receipt = await this.options.acceptExecutionMessage({
        execution,
        message: input.prompt,
        inputId,
      });
      if (receipt.accepted)
        return { started: false, accepted: true, inputId, execution };
    }
    // Completion won the input-store transaction. Wait for this same execution's
    // ownership to settle before attempting a new one; never enqueue the message.
    if (!(await this.waitForCleanup(lease.cleaned)))
      return {
        started: false,
        reason:
          "The previous execution is still cleaning up; this message was not accepted.",
      };
    return this.launch(input);
  }

  private messageInputId(input: SubagentSendInput): string {
    return `subagent-send:${createHash("sha256")
      .update(
        JSON.stringify([
          input.requesterRunId,
          input.requesterMessageId,
          input.requestId,
        ]),
      )
      .digest("hex")}`;
  }

  private beginCleanup(lease: ExecutionLease): void {
    if (lease.cleaning) return;
    lease.resolveReady();
    const settlement = this.settlingTurns.get(lease.subagentId);
    const operation = (async (): Promise<void> => {
      const execution = lease.execution
        ? await this.options.executionStore.get({
            executionId: lease.executionId,
            parentSessionId: lease.parentSessionId,
          })
        : undefined;
      if (execution) {
        const reason = lease.closing
          ? "closed"
          : (lease.stopReason ?? execution.status);
        if (execution.status !== "completed") {
          lease.unprocessedMessages =
            (await this.options.closeExecutionInputs?.({
              execution,
              reason,
            })) ?? [];
          if (lease.unprocessedMessages.length)
            this.unprocessed.set(lease.subagentId, lease.unprocessedMessages);
        }
        const cleanup = await this.options.cleanupExecution?.({
          execution,
          reason,
        });
        if (cleanup && !cleanup.confirmed) {
          if (!cleanup.settled) return;
          await cleanup.settled;
        }
      }
      await settlement;
      if (lease.scopeCleanup) {
        const cleanup = await lease.scopeCleanup;
        if (!cleanup.confirmed) {
          if (!cleanup.settled) return;
          await cleanup.settled;
        }
      }
      if (this.leases.get(lease.executionId) !== lease) return;
      this.leases.delete(lease.executionId);
      this.executionBudgets.delete(lease.executionId);
      const rootRunId = this.rootByExecution.get(lease.executionId);
      this.rootByExecution.delete(lease.executionId);
      if (rootRunId && ![...this.rootByExecution.values()].includes(rootRunId))
        this.sealedRoots.delete(rootRunId);
      if (lease.closing) this.closedSubagents.delete(lease.subagentId);
      lease.resolveCleaned();
    })();
    lease.cleaning = operation;
    void operation.catch((error: unknown) => {
      if (lease.execution)
        this.options.onFatal?.(
          new Error(`Subagent cleanup is unconfirmed: ${errorMessage(error)}`),
          lease.execution.rootRunId,
        );
    });
  }

  private async waitForCleanup(cleaned: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        cleaned.then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, this.options.cleanupWaitMs ?? 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(input: SubagentStopInput): Promise<SubagentStopResult> {
    const lease = this.leaseFor(input.parentSessionId, input.subagentId);
    const mismatch =
      input.expectedExecutionId !== undefined &&
      lease?.executionId !== input.expectedExecutionId;
    if (lease && !mismatch) {
      lease.stopReason ??= "stopped";
      lease.controller.abort("subagent stopped");
      this.active
        .get(input.subagentId)
        ?.abortController?.abort("subagent stopped");
    }
    const item = await this.options.store.get(input);
    if (!item && !lease)
      throw new Error(`Subagent not found: ${input.subagentId}`);
    if (
      item?.closedAt !== undefined ||
      this.closedSubagents.has(input.subagentId)
    )
      throw new Error(`Subagent is closed: ${input.subagentId}`);
    if (mismatch)
      return {
        subagentId: input.subagentId,
        stopped: false,
        reason: "The expected execution is no longer active.",
        cleanup: "confirmed",
        unprocessedMessages: [],
      };
    if (!lease) {
      return {
        subagentId: input.subagentId,
        stopped: false,
        reason: "No active execution.",
        cleanup: "confirmed",
        unprocessedMessages: this.unprocessed.get(input.subagentId) ?? [],
      };
    }
    if (lease.execution)
      await this.finishExecution(lease.execution, {
        status: "interrupted",
        error: "subagent stopped",
        reason: "stopped",
        completedAt: this.now(),
      });
    const confirmed = await this.waitForCleanup(lease.cleaned);
    const execution = await this.options.executionStore.get({
      executionId: lease.executionId,
      parentSessionId: input.parentSessionId,
    });
    return {
      subagentId: input.subagentId,
      stopped: true,
      execution: execution ?? undefined,
      cleanup: confirmed ? "confirmed" : "unconfirmed",
      unprocessedMessages: lease.unprocessedMessages,
    };
  }

  async interruptForegroundByRootRun(
    rootRunId: string,
    reason = "stopped",
  ): Promise<readonly SubagentExecutionRecord[]> {
    const targets = [...this.leases.values()].filter(
      (lease) =>
        lease.execution?.rootRunId === rootRunId &&
        lease.execution.mode === "foreground",
    );
    for (const lease of targets) {
      lease.stopReason = reason;
      lease.controller.abort(reason);
      this.active.get(lease.subagentId)?.abortController?.abort(reason);
    }
    await Promise.all(
      targets.map((lease) =>
        this.stop({
          parentSessionId: lease.parentSessionId,
          subagentId: lease.subagentId,
          expectedExecutionId: lease.executionId,
        }),
      ),
    );
    return (await this.options.executionStore.listByRootRun(rootRunId)).filter(
      (execution) => execution.mode === "foreground",
    );
  }

  async list(input: SubagentStatusInput): Promise<SubagentStatusResult> {
    const items = (
      await this.options.store.listByParent(input.parentSessionId)
    ).filter(
      (item) =>
        item.closedAt === undefined &&
        (!input.subagentId || item.subagentId === input.subagentId),
    );
    const executions = (
      await Promise.all(
        items.map((item) =>
          this.options.executionStore.list({
            parentSessionId: input.parentSessionId,
            requesterScopeId:
              input.parentContextScopeId ?? PRIMARY_SUBAGENT_REQUESTER_SCOPE,
            subagentId: item.subagentId,
            limit: 1,
          }),
        ),
      )
    ).flat();
    const facts = this.options.collectExecutionFacts
      ? await Promise.all(executions.map(this.options.collectExecutionFacts))
      : undefined;
    return {
      items,
      executions,
      facts,
      runtime: await Promise.all(
        items.map(async (item) => {
          const lease = this.leaseFor(input.parentSessionId, item.subagentId);
          const execution = executions.find(
            (record) => record.subagentId === item.subagentId,
          );
          const messages =
            execution && this.options.readExecutionInputs
              ? await this.options.readExecutionInputs({ execution })
              : (this.unprocessed.get(item.subagentId) ?? []);
          return {
            subagentId: item.subagentId,
            executionId: lease?.executionId,
            settling:
              lease?.cleaning !== undefined ||
              this.settlingTurns.has(item.subagentId),
            unprocessedMessages: messages,
          };
        }),
      ),
    };
  }

  monitor(input: SubagentMonitorInput): Promise<SubagentMonitorResult> {
    if (!this.options.readHistory)
      return Promise.reject(
        new Error("Subagent history reader is unavailable"),
      );
    return this.options.readHistory(input);
  }

  private async executionWrite<T>(
    rootRunId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SubagentExecutionConflictError) throw error;
      this.sealedRoots.add(rootRunId);
      const failure = new SubagentPersistenceError(errorMessage(error));
      this.options.onFatal?.(failure, rootRunId);
      throw failure;
    }
  }

  private assertRootOpen(rootRunId: string, parentSessionId: string): void {
    if (
      this.disposed ||
      this.sealedRoots.has(rootRunId) ||
      this.sealedParents.has(parentSessionId)
    )
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
    for (const lease of this.leases.values()) {
      if (lease.execution?.rootRunId !== rootRunId) continue;
      lease.stopReason = reason;
      lease.controller.abort(reason);
    }
    for (const active of this.active.values()) {
      if (active.currentExecution?.rootRunId === rootRunId)
        active.abortController?.abort(reason);
    }
    const interrupted = await this.options.executionStore.interruptRoot(
      rootRunId,
      reason,
      this.now(),
    );
    // Include prior terminals so a retry can finish a failed instance-queue write.
    // Instances may no longer be present in this host's active map.
    const executions =
      await this.options.executionStore.listByRootRun(rootRunId);
    const targets = new Map<
      string,
      { parentSessionId: string; executionIds: Set<string> }
    >();
    for (const execution of executions) {
      let target = targets.get(execution.subagentId);
      if (!target) {
        target = {
          parentSessionId: execution.parentSessionId,
          executionIds: new Set(),
        };
        targets.set(execution.subagentId, target);
      }
      target.executionIds.add(execution.executionId);
    }
    for (const [subagentId, active] of this.active) {
      if (
        !targets.has(subagentId) &&
        active.currentExecution?.rootRunId === rootRunId
      )
        targets.set(subagentId, {
          parentSessionId: active.parentSessionId,
          executionIds: new Set(),
        });
    }
    for (const [subagentId, target] of targets) {
      await this.withSubagentLock(subagentId, async () => {
        const record = await this.options.store.get({
          subagentId,
          parentSessionId: target.parentSessionId,
        });
        if (!record) return; // An accepted child can still be awaiting creation.
        const belongsToRoot = (entry: QueuedSubagentInput): boolean =>
          entry.rootRunId === rootRunId ||
          (entry.executionId !== undefined &&
            target.executionIds.has(entry.executionId));
        const pendingQueue = record.pendingQueue.filter(
          (entry) => !belongsToRoot(entry),
        );
        const item =
          pendingQueue.length === record.pendingQueue.length
            ? record
            : await this.options.store.update(subagentId, {
                pendingQueue,
                updatedAt: this.now(),
              });
        void item;
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
    const collectFacts = this.options.collectExecutionFacts;
    const facts = collectFacts
      ? await Promise.all(
          executions.map((execution) => collectFacts(execution)),
        )
      : undefined;
    if (input.executionId && this.options.ensureResultArtifact) {
      for (const execution of executions) {
        if (execution.status === "queued" || execution.status === "running")
          continue;
        await this.options.ensureResultArtifact(execution);
      }
      const refreshed = await Promise.all(
        executions.map((execution) =>
          this.options.executionStore.get(execution),
        ),
      );
      return {
        items,
        facts,
        executions: refreshed.filter(
          (execution): execution is SubagentExecutionRecord =>
            execution !== null,
        ),
      };
    }
    return { items, executions, ...(facts ? { facts } : {}) };
  }

  close(input: SubagentLookupInput): Promise<SubagentCloseResult> {
    const key = JSON.stringify([input.parentSessionId, input.subagentId]);
    const previous = this.closeOperations.get(key);
    if (previous) return previous;
    const lease = this.leaseFor(input.parentSessionId, input.subagentId);
    let resolveScopeCleanup:
      | ((cleanup: SubagentCleanupResult) => void)
      | undefined;
    if (lease) {
      lease.scopeCleanup = new Promise<SubagentCleanupResult>((resolve) => {
        resolveScopeCleanup = resolve;
      });
      lease.closing = true;
      lease.stopReason = "closed";
      lease.controller.abort("subagent closed");
    }
    const operation = (async (): Promise<SubagentCloseResult> => {
      const result = await this.closeRecord(input);
      const scopeCleanup: Promise<SubagentCleanupResult> =
        this.closingScopes.get(key) ??
        (result.item && result.reason !== "already closed"
          ? Promise.resolve(
              this.options.onClosed?.({
                contextScopeId: result.item.contextScopeId,
                sessionId: result.item.sessionId,
                subagentId: result.item.subagentId,
                runId: result.item.currentRunId ?? result.item.lastRunId,
              }),
            ).then((cleanup) => cleanup ?? { confirmed: true })
          : Promise.resolve({ confirmed: true }));
      this.closingScopes.set(key, scopeCleanup);
      void scopeCleanup
        .then((cleanup) => resolveScopeCleanup?.(cleanup))
        .catch(() => undefined);
      const scopeSettled = scopeCleanup.then(async (cleanup) => {
        if (!cleanup.confirmed) {
          if (!cleanup.settled) return new Promise<void>(() => undefined);
          await cleanup.settled;
        }
      });
      void scopeSettled
        .then(() => {
          this.closingScopes.delete(key);
          if (!lease) this.closedSubagents.delete(input.subagentId);
        })
        .catch(() => undefined);
      const confirmed = await this.waitForCleanup(
        Promise.all([scopeSettled, lease?.cleaned]).then(() => undefined),
      );
      const unprocessedMessages =
        lease?.unprocessedMessages ??
        this.unprocessed.get(input.subagentId) ??
        [];
      if (confirmed) {
        this.closedSubagents.delete(input.subagentId);
        this.unprocessed.delete(input.subagentId);
      }
      return {
        ...result,
        cleanup: confirmed ? "confirmed" : "unconfirmed",
        unprocessedMessages,
      };
    })();
    this.closeOperations.set(key, operation);
    void operation
      .finally(() => {
        if (this.closeOperations.get(key) === operation)
          this.closeOperations.delete(key);
      })
      .catch(() => undefined);
    return operation;
  }

  private async closeRecord(
    input: SubagentLookupInput,
  ): Promise<Omit<SubagentCloseResult, "cleanup" | "unprocessedMessages">> {
    return this.withSubagentLock(input.subagentId, async () => {
      const item = await this.options.store.get(input);
      if (item?.closedAt !== undefined)
        return {
          item,
          subagentId: input.subagentId,
          previousStatus: item.status,
          reason: "already closed",
        };
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
    options: { readonly closeAdmission?: boolean } = {},
  ): Promise<readonly SubagentInstanceRecord[]> {
    // Parent removal closes admission before any pending accept/create/bind can resume.
    if (options.closeAdmission) this.sealedParents.add(parentSessionId);
    const leases = [...this.leases.values()].filter(
      (lease) => lease.parentSessionId === parentSessionId,
    );
    const roots = new Set<string>();
    for (const lease of leases) {
      lease.stopReason = reason;
      lease.controller.abort(reason);
      if (lease.execution) roots.add(lease.execution.rootRunId);
    }
    const targets = [...this.active.entries()].filter(
      ([, active]) => active.parentSessionId === parentSessionId,
    );
    for (const [, active] of targets) {
      active.pauseReason = reason;
      active.pauseController.abort(reason);
      active.abortController?.abort(reason);
      if (active.currentExecution?.rootRunId)
        roots.add(active.currentExecution.rootRunId);
    }
    await Promise.all(
      [...roots].map((rootRunId) => this.interruptByRootRun(rootRunId, reason)),
    );
    await Promise.all(
      targets.map(async ([, active]) => {
        await active.drainPromise?.catch(() => undefined);
      }),
    );
    const subagentIds = new Set([
      ...leases.map((lease) => lease.subagentId),
      ...targets.map(([subagentId]) => subagentId),
    ]);
    const records = await Promise.all(
      [...subagentIds].map((subagentId) =>
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
      this.leases.size > 0 ||
      this.executionJobs.size > 0 ||
      this.settlingTurns.size > 0 ||
      [...this.active.values()].some((active) => active.running)
    );
  }

  private disposal: Promise<void> | undefined;

  closeAdmission(): void {
    this.disposed = true;
    for (const lease of this.leases.values()) {
      lease.stopReason = "service-shutdown";
      lease.controller.abort("service-shutdown");
    }
    for (const rootRunId of this.rootByExecution.values())
      this.sealedRoots.add(rootRunId);
    for (const active of this.active.values()) {
      active.stopping = true;
      active.pauseController.abort("service-shutdown");
      active.abortController?.abort("service-shutdown");
    }
  }

  dispose(): Promise<void> {
    this.closeAdmission();
    if (this.disposal) return this.disposal;
    this.disposal = (async (): Promise<void> => {
      const operations = [
        ...[...this.rootByExecution.values()].map((rootRunId) =>
          this.interruptByRootRun(rootRunId, "service-shutdown"),
        ),
        this.markOwnedInterrupted(),
        ...[...this.active.values()].flatMap((active) =>
          active.drainPromise ? [active.drainPromise] : [],
        ),
        ...this.settlingTurns.values(),
      ];
      const results = await Promise.allSettled(operations);
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result): unknown => result.reason),
          "Subagent cleanup failed",
        );
    })();
    return this.disposal;
  }

  private async createRecord(
    input: SubagentRunInput,
    execution: SubagentExecutionRecord,
  ): Promise<SubagentInstanceRecord> {
    if (!input.role) {
      throw new Error("role is required when creating a subagent");
    }
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      input.role,
      {
        isSubagent: true,
      },
    );
    assertNoStaticModelConfig(runtimeAgent.config, "SessionSubagentHost");
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
    this.assertRootOpen(execution.rootRunId, execution.parentSessionId);
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
      pendingQueue: [],
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
      this.sealedRoots.has(execution.rootRunId) ||
      this.sealedParents.has(execution.parentSessionId)
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
    return this.options.sessionManager.create(parent.workingDirectory, {
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
    _interrupt = false,
    timeoutMs?: number,
    _waitForEntry = false,
    signal?: AbortSignal,
    _entryAlreadyQueued = false,
    reasoning?: ReasoningIntent,
    execution?: SubagentExecutionRecord,
    onAdmitted?: () => void,
    runModel?: RunModel,
  ): Promise<EntryOutcome> {
    if (!execution) throw new Error("Accepted execution identity missing");
    this.assertRootOpen(execution.rootRunId, execution.parentSessionId);
    const entry: ActiveExecutionInput = {
      executionId: execution.executionId,
      rootRunId: execution.rootRunId,
      requesterRunId: execution.requesterRunId,
      requesterScopeId: execution.requesterScopeId,
      runModel,
      reasoning,
      environment,
      signal,
      prompt,
      timeoutMs,
      workdir: environment?.workdir,
    };
    const active = this.createActiveState(record.parentSessionId);
    active.currentExecution = entry;
    active.running = true;
    this.active.set(record.subagentId, active);
    const work = (async (): Promise<EntryOutcome> => {
      try {
        const current = await this.mustGet(
          record.parentSessionId,
          record.subagentId,
        );
        if (current.closedAt !== undefined)
          throw new Error(`Subagent is closed: ${record.subagentId}`);
        if (current.currentRunId !== undefined)
          throw new Error(
            `Subagent is active under another runtime owner: ${record.subagentId}`,
          );
        const runId = this.createRunId();
        const startedAt = this.now();
        await this.executionWrite(execution.rootRunId, () =>
          this.options.executionStore.start(execution, runId, startedAt),
        );
        this.assertRootOpen(execution.rootRunId, execution.parentSessionId);
        const claimed = await this.options.store.claim(record.subagentId, {
          completedAt: undefined,
          currentInput: this.serializeInput(entry),
          currentRunId: runId,
          error: undefined,
          interruptedAt: undefined,
          output: undefined,
          ownerId: this.options.ownerId,
          ownerPid: this.options.ownerPid,
          pendingQueue: [],
          startedAt,
          status: "running",
          updatedAt: startedAt,
        });
        if (!claimed)
          throw new Error(`Subagent run claim rejected: ${record.subagentId}`);
        onAdmitted?.();
        if (active.pauseReason !== undefined) {
          await this.finishExecution(execution, {
            status: "interrupted",
            reason: active.pauseReason,
            error: active.pauseReason,
            completedAt: this.now(),
          });
          return {
            item: await this.finishInterruptedRun(
              record,
              runId,
              active.pauseReason,
            ),
          };
        }
        return {
          item: await this.runTurn(
            record,
            entry,
            active,
            runId,
            timeoutMs ?? record.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
          ),
        };
      } finally {
        onAdmitted?.();
        active.running = false;
        if (this.active.get(record.subagentId) === active)
          this.active.delete(record.subagentId);
      }
    })();
    active.drainPromise = work.then(() => undefined);
    void active.drainPromise.catch(() => undefined);
    return work;
  }

  private async runTurn(
    record: SubagentInstanceRecord,
    input: ActiveExecutionInput,
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
        : createApprovalAwareDeadline({
            parent: abortController.signal,
            reason: timeoutMessage(effectiveTimeoutMs),
            timeoutMs: effectiveTimeoutMs,
            isApprovalBlocked: () =>
              input.executionId
                ? (this.options.isApprovalBlocked?.(
                    input.executionId,
                    record.parentSessionId,
                  ) ?? Promise.resolve(false))
                : Promise.resolve(false),
            subscribe: (wake) =>
              this.options.subscribeExecution?.(
                record.sessionId,
                runId,
                wake,
              ) ?? ((): void => undefined),
            onFailure: (error) => {
              if (input.rootRunId)
                this.options.onFatal?.(error, input.rootRunId);
            },
            now: this.options.now,
          });
    if (input.executionId && deadline)
      this.executionBudgets.set(input.executionId, () => deadline.snapshot());
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
      assertNoStaticModelConfig(runtimeAgent.config, "SessionSubagentHost");
      if (this.isActiveClosed(active) || this.isActiveStopping(active)) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      const session = await this.getChildSession(
        record.sessionId,
        record.parentSessionId,
      );
      const runModel =
        input.runModel ??
        (await this.options.getParentRunModel(
          record.parentSessionId,
          input.requesterScopeId === PRIMARY_SUBAGENT_REQUESTER_SCOPE
            ? undefined
            : input.requesterScopeId,
        ));
      const instance = this.options.instanceFactory.create({
        agentName: record.role,
        contextScopeId: record.contextScopeId,
        instanceId: record.subagentId,
        maxSteps: runtimeAgent.config.maxSteps,
        modelId: runModel.client.config.model,
        parentSessionId: record.parentSessionId,
        projectRoot: session.workingDirectory,
        sessionId: record.sessionId,
        type: "sub",
      });
      const execution = input.executionId
        ? await this.options.executionStore.get({
            executionId: input.executionId,
            parentSessionId: record.parentSessionId,
          })
        : null;
      if (input.rootRunId)
        this.assertRootOpen(input.rootRunId, record.parentSessionId);
      if (turnSignal.aborted) return await markInterrupted();
      active.lastRunSettled = false;
      let turnPromise: Promise<AgentRunResult>;
      try {
        turnPromise = instance.turn({
          runModel,
          ...(input.reasoning === undefined
            ? {}
            : { reasoning: input.reasoning }),
          environment: input.environment,
          prompt: input.prompt,
          ...(execution?.childUserMessageId === undefined
            ? {}
            : { initialUserMessageId: execution.childUserMessageId }),
          runId,
          signal: turnSignal,
          waitMode: "waitForCompletion",
          workdir: input.workdir,
          onInputReady: () => {
            if (input.executionId)
              this.leases.get(input.executionId)?.resolveReady();
          },
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
      if (turn.kind === "aborted") trackSettlement();
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

  private createActiveState(parentSessionId: string): ActiveSubagentState {
    return {
      closed: false,
      lastRunSettled: true,
      parentSessionId,
      pauseController: new AbortController(),
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

  private serializeInput(input: ActiveExecutionInput): QueuedSubagentInput {
    const {
      runModel: _runModel,
      reasoning: _reasoning,
      environment,
      signal: _signal,
      ...item
    } = input;
    return {
      ...item,
      workdir: item.workdir ?? environment?.workdir,
    };
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
}

class SubagentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentPersistenceError";
  }
}
