import { ShellJobManagementError } from "./shell-job-recovery.js";
import type { ProcessIdentity } from "../shell/process-identity.js";
import fs from "node:fs";
import { initialShellJobNoticeState, boundedText } from "./shell-job-notice.js";
import {
  SHELL_JOB_STATUSES,
  ShellJobQueryError,
  isShellJobUnsettled,
} from "./shell-job-query.js";
import {
  decodeShellJobCursor,
  encodeShellJobCursor,
} from "./shell-job-reader.js";
import {
  InMemoryShellJobStore,
  ShellJobCapacityError,
  type ShellJobStore,
  type ShellJobRecord,
  type ShellJobPatch,
  type ShellJobPromotionPatch,
  type ShellJobStatus,
  type ShellJobStopReason,
} from "./shell-job-store.js";
import {
  waitForCleanup,
  type RunCleanupSnapshot,
  type ToolCleanupState,
} from "../core/tool-scheduler/run-cleanup.js";
import {
  probeProcessTree,
  type KillTreeResult,
  type ProcessTreeState,
} from "../shell/process.js";
import { beginSourceCleanup } from "../core/tool-scheduler/source-cleanup.js";
import type { ToolExecutionOwner } from "../core/tool-scheduler/types.js";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CappedOutputFile,
  outputFileNotice,
} from "../utils/capped-output-file.js";
import { DEFAULT_OUTPUT_TOKEN_LIMIT, truncateOutput } from "./utils/output.js";
import { ToolParameterError } from "./utils/params.js";

export const OUTPUT_CAPTURE_CHAR_LIMIT = DEFAULT_OUTPUT_TOKEN_LIMIT * 4 + 1;
export const SHELL_JOB_TERMINATION_GRACE_MS = 1_000;

export type { ShellJobStatus };

type TerminationReason = "cancelled" | "timed_out";

/** How a foreground wait's promotion attempt ended. */
export type ShellJobPromotion =
  | "converted"
  | "already_finished"
  /** Stopped before commit by Stop, closed owner admission or the hard deadline. */
  | "cancelled_before_commit"
  | "capacity_rejected"
  | "persistence_error";

export interface ForegroundWaitResult {
  readonly snapshot: ShellJobSnapshot;
  /** Absent when this call did not try to move the job to the background. */
  readonly promotion?: ShellJobPromotion;
}

type PromotionBlock =
  | { readonly kind: "finished" | "stopping" }
  | {
      readonly kind: "stop";
      readonly reason: TerminationReason;
      readonly stopReason: ShellJobStopReason;
    };

export interface ShellJobStartInput {
  /** Already prepared by the caller; the registry owns only jobId.log and capture. */
  readonly outputDirectory?: string;
  readonly background?: boolean;
  readonly signal?: AbortSignal;
  /** Called once the reservation is committed and registry owns the release. */
  readonly onReserved?: () => void;
  readonly child: () => ChildProcess;
  readonly owner?: ToolExecutionOwner;
  readonly release?: () => void | Promise<void>;
  readonly reportCleanupError?: (error: unknown) => void;
  readonly reportCleanup?: (state: ToolCleanupState) => void;
  readonly contextScopeId?: string;
  readonly sessionId: string;
  readonly timeoutMs: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ShellJobSnapshot {
  readonly jobId: string;
  readonly status: ShellJobStatus;
  readonly output: string;
  readonly truncated: boolean;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ShellJobListOptions {
  readonly includeFinished?: boolean;
  readonly status?: ShellJobStatus;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export type ShellJobSummary = Pick<
  ShellJobRecord,
  | "jobId"
  | "command"
  | "description"
  | "mode"
  | "stopReason"
  | "cleanup"
  | "createdAt"
  | "startedAt"
  | "endedAt"
  | "promotedAt"
  | "resultReadyAt"
  | "settledAt"
  | "timeoutMs"
  | "exitCode"
  | "signal"
  | "trackingReleasedAt"
  | "outputBytes"
  | "outputComplete"
  | "outputTruncated"
  | "outputCheckpointAt"
> & { readonly status: ShellJobStatus };

export interface ShellJobList {
  readonly jobs: readonly ShellJobSummary[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly filteredCount: number;
  readonly pendingStartCount: number;
}

export type ShellCleanupResult = RunCleanupSnapshot;

export interface ShellJobRegistryOptions {
  // Legacy custom shells may return void; absence of proof is never confirmation.

  readonly killTree: (
    child: ChildProcess,
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  ) => Promise<KillTreeResult | void> | KillTreeResult | void;
  readonly probeTree?: (child: ChildProcess) => ProcessTreeState;
  /** Upper bound for custom termination helpers that fail to settle. */
  readonly cleanupObservationMs?: number;
  /** The built-in terminator owns TERM and post-KILL observation budgets. */
  readonly terminationManagesObservation?: boolean;
  readonly outputDrainMs?: number;
  readonly maxOutputBytes?: number;
  readonly store?: ShellJobStore;
  readonly ownerId?: string;
  readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity>;
  readonly createJobId?: () => string;
  readonly admitsOwner?: (owner: ToolExecutionOwner) => boolean;
  readonly backgroundLimit?: (
    owner: ToolExecutionOwner | undefined,
  ) => Promise<number>;
  readonly recovery?: import("./shell-job-recovery.js").ShellJobRecovery;
  readonly refreshOwner?: (
    sessionId: string,
    contextScopeId: string | null,
  ) => Promise<void>;
}

interface UnspawnedJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly rootRunId?: string;
  readonly background: boolean;
  readonly reportCleanupError?: (error: unknown) => void;
  pendingPatch: ShellJobPatch;
  writing: boolean;
  releaseComplete: boolean;
  readonly waiters: Set<() => void>;
}

interface ShellJob {
  readonly outputFile: CappedOutputFile;
  outputBytes: number;
  checkpointBytes: number;
  tail: Buffer;
  persist: Promise<void>;
  pendingPatch: ShellJobPatch;
  identityPending: boolean;
  settling: boolean;
  resultReadyAt: number | null;
  foregroundObserved: boolean;
  outputComplete: boolean | null;
  stopReason: ShellJobStopReason | null;
  background: boolean;
  promotedAt: number | null;
  readonly timeoutMs: number | null;
  releaseComplete: boolean;
  releaseTask?: Promise<void>;
  readonly owner?: ToolExecutionOwner;
  readonly release?: () => void | Promise<void>;
  readonly reportCleanup?: ShellJobStartInput["reportCleanup"];
  readonly reportCleanupError?: ShellJobStartInput["reportCleanupError"];
  cleanup?: ToolCleanupState;
  sourceCleanup?: ReturnType<typeof beginSourceCleanup>;
  cleanupTask?: Promise<void>;
  resolveCleanup?: () => void;
  confirmationWaiters?: Set<() => void>;
  readonly resultWaiters: Set<() => void>;
  observation?: ReturnType<typeof setTimeout>;
  outputDrain?: ReturnType<typeof setTimeout>;
  closed: boolean;
  closing: boolean;
  exited: boolean;
  terminationSucceeded: boolean;
  readonly child: ChildProcess;
  readonly contextScopeId?: string;
  readonly jobId: string;
  readonly startedAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  status: ShellJobStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  terminationStarted: boolean;
  terminationReason?: TerminationReason;
  timeoutId?: ReturnType<typeof setTimeout>;
  terminal: Promise<void>;
  resolveTerminal: () => void;
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

function appendHead(
  current: string,
  chunk: string,
): { readonly output: string; readonly truncated: boolean } {
  const next = current + chunk;
  if (next.length <= OUTPUT_CAPTURE_CHAR_LIMIT) {
    return { output: next, truncated: false };
  }
  return {
    output: next.slice(0, OUTPUT_CAPTURE_CHAR_LIMIT),
    truncated: true,
  };
}

function emptyOutputMessage(job: ShellJob): string {
  if (job.error) {
    return `Command error: ${job.error}`;
  }
  switch (job.status) {
    case "running":
      return "Command is still running with no output.";
    case "completed":
      return "Command completed with no output.";
    case "failed":
      return "Command failed with no output.";
    case "cancelled":
      return "Command was cancelled with no output.";
    case "timed_out":
      return "Command timed out with no output.";
    case "lost":
      return "Command result is unknown.";
  }
}

function renderOutput(job: ShellJob): {
  readonly output: string;
  readonly truncated: boolean;
} {
  if (job.background) {
    const tail = new TextDecoder("utf-8")
      .decode(job.tail, { stream: true })
      .trimEnd();
    const truncated = job.truncated || job.outputBytes > job.tail.length;
    return { output: tail || emptyOutputMessage(job), truncated };
  }
  const combined = [job.stdout.trimEnd(), job.stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");
  const baseOutput = combined || emptyOutputMessage(job);
  const output = truncateOutput(baseOutput);
  return { output, truncated: job.truncated || output !== baseOutput };
}

/** Selects jobs by owner; applies to launched and never-launched jobs alike. */
type JobFilter = (job: {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly rootRunId?: string;
}) => boolean;
const inRootRun =
  (rootRunId: string): JobFilter =>
  (job) =>
    job.rootRunId === rootRunId;
const inSession =
  (sessionId: string): JobFilter =>
  (job) =>
    job.sessionId === sessionId;
const inScope =
  (sessionId: string, contextScopeId: string): JobFilter =>
  (job) =>
    job.sessionId === sessionId && job.contextScopeId === contextScopeId;

function isTerminal(status: ShellJobStatus): boolean {
  return status !== "running";
}

export class ShellJobRegistry {
  private admissionClosed = false;
  private readonly jobs = new Map<string, ShellJob>();
  private readonly unspawnedJobs = new Map<string, UnspawnedJob>();
  private readonly foregroundResults = new Map<
    string,
    { snapshot: ShellJobSnapshot; sessionId: string; contextScopeId?: string }
  >();
  private readonly store: ShellJobStore;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private ownerIdentity?: Promise<ProcessIdentity>;
  private readonly createJobId: () => string;
  private readonly killTree: ShellJobRegistryOptions["killTree"];

  constructor(private readonly options: ShellJobRegistryOptions) {
    this.store = options.store ?? new InMemoryShellJobStore();
    this.createJobId = options.createJobId ?? randomUUID;
    this.killTree = options.killTree;
  }

  async start(input: ShellJobStartInput): Promise<ShellJobSnapshot> {
    // Allocate identity before launch: registration failure must not orphan work.
    const jobId = this.createJobId();
    if (this.jobs.has(jobId))
      throw new Error("Shell job identity already exists.");
    const owner = input.owner;
    const rejected = (): boolean =>
      this.admissionClosed ||
      (owner !== undefined && this.options.admitsOwner?.(owner) === false);
    if (rejected()) throw new Error("Shell root run is closed.");
    const createdAt = Date.now();
    const identity = this.options.readProcessIdentity
      ? await (this.ownerIdentity ??= this.options.readProcessIdentity(
          process.pid,
        ))
      : undefined;
    const record = this.newRecord(
      jobId,
      input,
      createdAt,
      identity?.state === "present" ? identity.startToken : null,
    );
    const maxBackgroundJobs = input.background
      ? await this.backgroundCapacity(
          record.sessionId,
          record.contextScopeId,
          owner,
        )
      : undefined;
    const assertAdmitted = (): undefined => {
      if (input.signal?.aborted) throw new Error("Command was cancelled.");
      if (rejected()) throw new Error("Shell root run is closed.");
      return undefined;
    };
    await this.store.insert(record, { assertAdmitted, maxBackgroundJobs });
    input.onReserved?.();
    let child: ChildProcess;
    let cancelledBeforeSpawn = false;
    try {
      cancelledBeforeSpawn = input.signal?.aborted === true || rejected();
      assertAdmitted();
      child = input.child();
    } catch (error) {
      cancelledBeforeSpawn ||= input.signal?.aborted === true;
      await this.recordSpawnFailure(jobId, input, error, cancelledBeforeSpawn);
      throw error;
    }
    const job = this.newJob(jobId, input, child);
    this.jobs.set(job.jobId, job);
    this.persist(job, {
      ...this.outputFilePatch(job),
      status: "running",
      startedAt: job.startedAt,
      pid: child.pid ?? null,
      pgid: process.platform !== "win32" ? (child.pid ?? null) : null,
    });
    const registration = job.persist;
    this.attach(job);

    try {
      child.stdin?.end();
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      this.terminate(job, "cancelled");
    }
    // Stop can run inside the spawn factory. Register cleanup ownership before
    // terminating the process; a rejected admission must not abandon it.
    if (
      this.admissionClosed ||
      (!job.background &&
        job.owner !== undefined &&
        this.options.admitsOwner?.(job.owner) === false)
    )
      this.terminate(job, "cancelled");
    try {
      await registration;
    } catch (error) {
      job.identityPending = false;
      this.terminate(job, "cancelled", "owner-ended");
      throw error;
    }
    await this.recordProcessIdentity(job);
    try {
      await job.persist;
    } catch (error) {
      // The reservation transferred resource ownership before spawn. Keep that
      // responsibility while reporting that startup could not be persisted.
      this.terminate(job, "cancelled", "owner-ended");
      throw error;
    }
    return this.snapshot(job);
  }

  /** The placeholder committed before spawn; later facts arrive as patches. */
  private newRecord(
    jobId: string,
    input: ShellJobStartInput,
    createdAt: number,
    ownerStartToken: string | null,
  ): ShellJobRecord {
    const owner = input.owner;
    const text = (key: string): string | undefined => {
      const field = input.metadata?.[key];
      return typeof field === "string" ? field : undefined;
    };
    return {
      jobId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId ?? null,
      rootSessionId: owner?.rootSessionId ?? input.sessionId,
      workspaceKey: owner?.workspaceKey ?? null,
      rootRunId: owner?.rootRunId ?? null,
      runId: owner?.runId ?? null,
      messageId: owner?.messageId ?? null,
      callId: owner?.callId ?? null,
      mode: input.background ? "background" : "foreground",
      promotedAt: null,
      command: text("command") ?? "",
      description: text("description") ?? null,
      cwd: text("cwd") ?? "",
      shell: text("shell") ?? "",
      timeoutMs: input.timeoutMs,
      status: null,
      stopReason: null,
      exitCode: null,
      signal: null,
      error: null,
      pid: null,
      pgid: null,
      processStartToken: null,
      recoveryClaim: null,
      ownerPid: process.pid,
      ownerId: this.options.ownerId ?? null,
      ownerStartToken,
      goalId: owner?.goalId ?? null,
      createdAt,
      startedAt: null,
      endedAt: null,
      settledAt: null,
      resultReadyAt: null,
      outputPath: null,
      outputBytes: 0,
      outputTruncated: false,
      outputTail: null,
      outputCheckpointAt: null,
      outputComplete: null,
      cleanup: null,
      trackingReleasedAt: null,
      noticeState: input.background ? null : "suppressed",
      noticeBatchId: null,
      noticePayload: null,
      noticeInputId: null,
      noticeWakeRunId: null,
    };
  }

  /** The reservation exists but no process does: record the outcome and release. */
  private async recordSpawnFailure(
    jobId: string,
    input: ShellJobStartInput,
    error: unknown,
    cancelled: boolean,
  ): Promise<void> {
    const pending: UnspawnedJob = {
      jobId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId,
      rootRunId: input.owner?.rootRunId,
      background: input.background ?? false,
      reportCleanupError: input.reportCleanupError,
      pendingPatch: {},
      writing: false,
      releaseComplete: false,
      waiters: new Set(),
    };
    this.unspawnedJobs.set(jobId, pending);
    await this.persistUnspawned(pending, {
      status: cancelled ? "cancelled" : "failed",
      stopReason: cancelled
        ? input.signal?.aborted
          ? "user"
          : "owner-ended"
        : null,
      error: cancelled
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
      cleanup: "confirmed",
      outputComplete: true,
      noticeState: input.background && !cancelled ? "pending" : "suppressed",
      resultReadyAt: Date.now(),
    });
    try {
      await input.release?.();
      pending.releaseComplete = true;
      await this.persistUnspawned(pending, {});
    } catch (releaseError) {
      try {
        input.reportCleanupError?.(releaseError);
      } catch {
        /* Observer does not own cleanup. */
      }
    }
  }

  private newJob(
    jobId: string,
    input: ShellJobStartInput,
    child: ChildProcess,
  ): ShellJob {
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const job: ShellJob = {
      outputFile: new CappedOutputFile(
        input.outputDirectory
          ? path.join(input.outputDirectory, `${jobId}.log`)
          : undefined,
      ),
      child,
      outputBytes: 0,
      checkpointBytes: 0,
      tail: Buffer.alloc(0),
      persist: Promise.resolve(),
      pendingPatch: {},
      identityPending: Boolean(child.pid && this.options.readProcessIdentity),
      settling: false,
      resultReadyAt: null,
      foregroundObserved: false,
      outputComplete: null,
      stopReason: null,
      background: input.background ?? false,
      promotedAt: null,
      timeoutMs: input.timeoutMs,
      releaseComplete: false,
      owner: input.owner,
      release: input.release,
      reportCleanup: input.reportCleanup,
      reportCleanupError: input.reportCleanupError,
      closed: false,
      closing: false,
      exited: false,
      terminationSucceeded: false,
      contextScopeId: input.contextScopeId,
      jobId,
      startedAt: Date.now(),
      metadata: { ...input.metadata, pid: child.pid },
      stderr: "",
      stdout: "",
      resolveTerminal,
      resultWaiters: new Set(),
      sessionId: input.sessionId,
      status: "running",
      terminal,
      terminationStarted: false,
      timeoutId:
        input.timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.terminate(job, "timed_out");
            }, input.timeoutMs),
      truncated: false,
    };
    return job;
  }

  /** Wire the child's output and lifecycle events to the job. */
  private attach(job: ShellJob): void {
    const child = job.child;
    const onOutput =
      (stream: "stdout" | "stderr") =>
      (chunk: unknown): void => {
        this.capture(job, chunk);
        // Background output is rendered from the shared byte tail only.
        if (job.background) return;
        const next = appendHead(job[stream], chunkToString(chunk));
        job[stream] = next.output;
        job.truncated ||= next.truncated;
      };
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    const outputError = (error: Error): void => {
      job.outputComplete = false;
      job.outputFile.finish(false);
      job.reportCleanupError?.(error);
    };
    child.stdout?.on("error", outputError);
    child.stderr?.on("error", outputError);
    child.once("error", (error: Error) => {
      job.error = error.message;
    });
    child.once("exit", (exitCode, signal) => {
      job.exited = true;
      this.persist(job, { endedAt: Date.now(), exitCode, signal });
      job.exitCode = exitCode;
      job.signal = signal;
      this.observeStopped(job);
    });
    child.once("close", (exitCode, signal) => {
      job.closing = true;
      job.closed = true;
      job.outputComplete ??= true;
      job.outputFile.finish(job.terminationReason === undefined);
      job.exitCode ??= exitCode;
      job.signal ??= signal;
      // Spawn failure without a PID proves no managed process was launched.
      if (job.error && !job.child.pid) this.confirmStopped(job);
      else this.observeStopped(job);
      // The shell exit result is distinct from proof that descendants stopped.
      this.finishFromChild(job, job.exitCode ?? null, job.signal ?? null);
      this.persist(job, {
        exitCode: job.exitCode ?? null,
        signal: job.signal ?? null,
        outputBytes: job.outputBytes,
        outputComplete: job.outputComplete,
        ...this.outputFilePatch(job),
        ...this.resultReadyPatch(job),
        outputTail: job.background ? this.tailText(job) : null,
        outputCheckpointAt: job.background ? Date.now() : null,
      });
      job.closing = false;
      this.settle(job);
    });
  }

  /** Recovery may signal a recorded group only when its birth identity matches. */
  private async recordProcessIdentity(job: ShellJob): Promise<void> {
    const pid = job.child.pid;
    if (!pid || !this.options.readProcessIdentity) return;
    try {
      const identity = await this.options.readProcessIdentity(pid);
      if (!job.exited && identity.state === "present" && identity.pgid === pid)
        this.persist(job, {
          pgid: identity.pgid,
          processStartToken: identity.startToken,
        });
    } catch (error) {
      job.reportCleanupError?.(error);
    } finally {
      job.identityPending = false;
      this.settle(job);
    }
  }

  get(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): ShellJobSnapshot {
    const job = this.jobs.get(jobId);
    if (job)
      return this.snapshot(this.getOwnedJob(jobId, sessionId, contextScopeId));
    return this.snapshotRecord(
      this.getOwnedRecord(jobId, sessionId, contextScopeId),
    );
  }

  /** Raw live facts for backend readers; tool-formatted output is deliberately separate. */
  getCurrentRecord(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): {
    readonly record: ShellJobRecord;
    readonly source: "live" | "saved";
    readonly sampledAt: number;
  } {
    const record = this.getOwnedRecord(jobId, sessionId, contextScopeId);
    const job = this.jobs.get(jobId);
    const sampledAt = Date.now();
    if (!job) return { record, source: "saved", sampledAt };
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    return {
      source: "live",
      sampledAt,
      record: {
        ...record,
        ...this.outputFilePatch(job),
        status: job.status,
        stopReason: job.stopReason,
        exitCode: job.exitCode ?? record.exitCode,
        signal: job.signal ?? record.signal,
        error: job.error ?? record.error,
        cleanup: job.cleanup ?? record.cleanup,
        outputBytes: job.outputBytes,
        outputComplete: job.outputComplete,
        outputTail: job.background ? this.tailText(job) : null,
      },
    };
  }

  /** Query-time observation only. It neither sends a signal nor claims foreign work. */
  async refreshRoot(rootSessionId: string): Promise<void> {
    const rows = this.store.listUnsettled(rootSessionId);
    const owners = new Map(
      rows.map((row) => [
        JSON.stringify([row.sessionId, row.contextScopeId]),
        row,
      ]),
    );
    for (const row of owners.values())
      await this.refreshLocalOwner(row.sessionId, row.contextScopeId);
    for (const row of rows) {
      if (!this.store.get(row.jobId)) continue;
      try {
        await this.options.recovery?.refresh(row.jobId);
      } catch (error) {
        // Another backend may delete a now-settled session during the probe.
        if (this.store.get(row.jobId)) throw error;
      }
    }
  }

  hasPendingCleanup(): boolean {
    return (
      [...this.jobs.values()].some(
        (job) => job.terminationStarted || (!job.background && job.closed),
      ) || this.unspawnedJobs.size > 0
    );
  }

  hasBackgroundWork(): boolean {
    return (
      [...this.jobs.values()].some((job) => job.background) ||
      [...this.unspawnedJobs.values()].some((job) => job.background)
    );
  }

  hasActiveWork(rootRunId?: string): boolean {
    if (rootRunId === undefined)
      return this.jobs.size > 0 || this.unspawnedJobs.size > 0;
    const filter = inRootRun(rootRunId);
    return (
      this.jobsWhere(filter).length > 0 ||
      this.unspawnedWhere(filter).length > 0
    );
  }

  private jobsWhere(filter: JobFilter): ShellJob[] {
    return [...this.jobs.values()].filter((job) =>
      filter({
        sessionId: job.sessionId,
        contextScopeId: job.contextScopeId,
        rootRunId: job.owner?.rootRunId,
      }),
    );
  }

  private unspawnedWhere(filter: JobFilter): UnspawnedJob[] {
    return [...this.unspawnedJobs.values()].filter(filter);
  }

  /** Stop the selected jobs and report whether their cleanup is confirmed. */
  private async stopJobs(
    jobs: readonly ShellJob[],
    filter: JobFilter,
    reason: ShellJobStopReason,
  ): Promise<ShellCleanupResult> {
    for (const job of jobs)
      if (job.cleanup === "unconfirmed") this.observeStopped(job);
    await this.disposeJobs(jobs, reason);
    return this.confirmCleanup(jobs, this.unspawnedWhere(filter));
  }

  stopForeground(rootRunId: string, reason: ShellJobStopReason): void {
    for (const job of this.jobsWhere(inRootRun(rootRunId)))
      if (!job.background) this.terminate(job, "cancelled", reason);
  }

  markRootRunStopped(rootRunId: string, reason: ShellJobStopReason): void {
    for (const job of this.jobsWhere(inRootRun(rootRunId)))
      this.terminate(job, "cancelled", reason);
  }

  stopByRootRun(
    rootRunId: string,
    reason: ShellJobStopReason,
  ): Promise<ShellCleanupResult> {
    const filter = inRootRun(rootRunId);
    return this.stopJobs(this.jobsWhere(filter), filter, reason);
  }

  /** Refreshes the owner's stale rows, then reads its limit; none is enforced without one. */
  private async backgroundCapacity(
    sessionId: string,
    contextScopeId: string | null,
    owner: ToolExecutionOwner | undefined,
  ): Promise<number | undefined> {
    await this.refreshLocalOwner(sessionId, contextScopeId);
    await this.options.refreshOwner?.(sessionId, contextScopeId);
    return this.options.backgroundLimit?.(owner);
  }

  async refreshLocalOwner(
    sessionId: string,
    contextScopeId: string | null,
  ): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        job.sessionId === sessionId &&
        (job.contextScopeId ?? null) === contextScopeId &&
        (job.cleanup === "unconfirmed" ||
          (job.closed && job.cleanup !== "confirmed")),
    );
    for (const job of jobs) this.observeStopped(job);
    await Promise.all(jobs.map((job) => job.persist.catch(() => undefined)));
  }

  /** Model reads are always scoped to the trusted calling session and context. */
  async list(
    sessionId: string,
    options: ShellJobListOptions = {},
    contextScopeId?: string,
  ): Promise<ShellJobList> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ShellJobQueryError(
        "Shell task page limit must be an integer from 1 to 100.",
      );
    if (
      options.includeFinished !== undefined &&
      typeof options.includeFinished !== "boolean"
    )
      throw new ShellJobQueryError("includeFinished must be a boolean.");
    if (
      options.status !== undefined &&
      !SHELL_JOB_STATUSES.includes(options.status)
    )
      throw new ShellJobQueryError("Invalid task status filter.");
    if (options.status !== undefined && options.includeFinished !== undefined)
      throw new ShellJobQueryError(
        "status and includeFinished cannot be combined.",
      );
    const scope = { sessionId, contextScopeId: contextScopeId ?? null };
    const filter = {
      includeFinished: options.includeFinished ?? true,
      ...(options.status ? { statuses: [options.status] } : {}),
    };
    const before = decodeShellJobCursor(options.cursor, scope, filter);
    options.signal?.throwIfAborted();
    await this.refreshLocalOwner(sessionId, scope.contextScopeId);
    await this.options.refreshOwner?.(sessionId, scope.contextScopeId);
    options.signal?.throwIfAborted();
    const page = this.store.query({ scope, ...filter, limit, before });
    // Project saved metadata only: listing does not open or stat individual logs.
    const jobs = page.rows.map((record): ShellJobSummary => {
      if (record.status === null)
        throw new ShellJobQueryError(
          "Task launch registration has not finished.",
        );
      return {
        jobId: record.jobId,
        command: boundedText(record.command, 1024),
        description:
          record.description === null
            ? null
            : boundedText(record.description, 512),
        mode: record.mode,
        status: record.status,
        stopReason: record.stopReason,
        cleanup: record.cleanup,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        promotedAt: record.promotedAt,
        resultReadyAt: record.resultReadyAt,
        settledAt: record.settledAt,
        timeoutMs: record.timeoutMs,
        exitCode: record.exitCode,
        signal: record.signal,
        trackingReleasedAt: record.trackingReleasedAt,
        outputBytes: record.outputBytes,
        outputComplete: record.outputComplete,
        outputTruncated: record.outputTruncated,
        outputCheckpointAt: record.outputCheckpointAt,
      };
    });
    return {
      jobs,
      hasMore: page.hasMore,
      ...(page.next
        ? { nextCursor: encodeShellJobCursor(scope, filter, page.next) }
        : {}),
      filteredCount: page.filteredCount,
      pendingStartCount: page.pendingStartCount,
    };
  }

  async cleanupScope(
    sessionId: string,
    contextScopeId: string,
  ): Promise<ShellCleanupResult> {
    const filter = inScope(sessionId, contextScopeId);
    const jobs = this.jobsWhere(filter);
    await this.refreshLocalOwner(sessionId, contextScopeId);
    return this.stopJobs(jobs, filter, "owner-ended");
  }

  private async confirmCleanup(
    jobs: readonly ShellJob[],
    unspawned: readonly UnspawnedJob[] = [],
  ): Promise<ShellCleanupResult> {
    await Promise.all(
      jobs.flatMap((job) => (job.cleanupTask ? [job.cleanupTask] : [])),
    );
    await Promise.all(jobs.map((job) => job.persist.catch(() => undefined)));
    const pending = jobs.filter((job) => this.jobs.has(job.jobId));
    const pendingUnspawned = unspawned.filter((job) =>
      this.unspawnedJobs.has(job.jobId),
    );
    if (pending.length === 0 && pendingUnspawned.length === 0)
      return { confirmed: true };
    const removers: (() => void)[] = [];
    const waiting = [
      ...pending.map(
        (job) =>
          new Promise<void>((resolve) => {
            const waiters = (job.confirmationWaiters ??= new Set());
            waiters.add(resolve);
            removers.push(() => {
              waiters.delete(resolve);
            });
          }),
      ),
      ...pendingUnspawned.map(
        (job) =>
          new Promise<void>((resolve) => {
            job.waiters.add(resolve);
            removers.push(() => {
              job.waiters.delete(resolve);
            });
          }),
      ),
    ];
    return {
      confirmed: false,
      settled: Promise.all(waiting).then(() => undefined),
      cancelWait: () => {
        for (const remove of removers) remove();
      },
    };
  }

  /** Wait belongs to this invocation; the process deadline remains with the job. */
  async waitForForeground(
    jobId: string,
    sessionId: string,
    input: {
      readonly waitMs?: number;
      readonly signal: AbortSignal;
      readonly onBackground: () => void;
    },
    contextScopeId?: string,
  ): Promise<ForegroundWaitResult> {
    const job = this.jobs.get(jobId);
    if (!job)
      return {
        snapshot: await this.waitForTerminal(jobId, sessionId, contextScopeId),
      };
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    const abort = (): void => {
      if (!job.background) this.terminate(job, "cancelled", "user");
    };
    const detach = (): void => {
      input.signal.removeEventListener("abort", abort);
      input.onBackground();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      if (input.waitMs !== undefined) {
        const waitUntil = job.startedAt + input.waitMs;
        while (job.status === "running" && !job.exited) {
          const remaining = waitUntil - Date.now();
          if (remaining <= 0) break;
          await this.output(
            jobId,
            sessionId,
            { block: true, waitMs: remaining },
            contextScopeId,
          );
        }
        const promotion = await this.promote(job, input.signal, detach);
        return {
          snapshot:
            promotion === "converted"
              ? this.snapshot(job)
              : await this.waitForTerminal(jobId, sessionId, contextScopeId),
          promotion,
        };
      }
      return {
        snapshot: await this.waitForTerminal(jobId, sessionId, contextScopeId),
      };
    } finally {
      if (!job.background) input.signal.removeEventListener("abort", abort);
    }
  }

  private async promote(
    job: ShellJob,
    signal: AbortSignal,
    onCommitted: () => void,
  ): Promise<ShellJobPromotion> {
    const early = this.promotionBlock(job, signal, Date.now());
    if (early) return this.applyPromotionBlock(job, early);
    // Decided under the write lock but applied after it, because stopping a job
    // reports cleanup to its caller and must not run inside the transaction.
    let blocked = null as PromotionBlock | null;
    try {
      const maxBackgroundJobs = await this.backgroundCapacity(
        job.sessionId,
        job.contextScopeId ?? null,
        job.owner,
      );
      const promotion = job.persist.then(() =>
        this.store.promote(job.jobId, {
          maxBackgroundJobs,
          prepare: () => {
            const now = Date.now();
            blocked = this.promotionBlock(job, signal, now);
            return blocked ? null : this.promotionCheckpoint(job, now);
          },
          onCommitted: (record) => {
            job.background = true;
            job.promotedAt = record.promotedAt;
            onCommitted();
          },
        }),
      );
      job.persist = promotion.then(() => undefined);
      if (await promotion) {
        this.scheduleCheckpoint();
        return "converted";
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      const capacity = error instanceof ShellJobCapacityError;
      this.terminate(
        job,
        "cancelled",
        capacity ? "capacity-limit" : "internal-error",
      );
      return capacity ? "capacity_rejected" : "persistence_error";
    }
    // The store declines only when the runtime recheck did, so blocked is set.
    return this.applyPromotionBlock(job, blocked ?? { kind: "finished" });
  }

  /** Pure check: why this job can no longer move to the background, if at all. */
  private promotionBlock(
    job: ShellJob,
    signal: AbortSignal,
    now: number,
  ): PromotionBlock | null {
    if (job.terminationStarted) return { kind: "stopping" };
    // Exit precedes close/output drainage; it is already too late to detach.
    if (job.status !== "running" || job.exited || job.closed)
      return { kind: "finished" };
    if (signal.aborted)
      return { kind: "stop", reason: "cancelled", stopReason: "user" };
    if (
      this.admissionClosed ||
      (job.owner && this.options.admitsOwner?.(job.owner) === false)
    )
      return { kind: "stop", reason: "cancelled", stopReason: "owner-ended" };
    if (job.timeoutMs !== null && now >= job.startedAt + job.timeoutMs)
      return { kind: "stop", reason: "timed_out", stopReason: "timeout" };
    return null;
  }

  private applyPromotionBlock(
    job: ShellJob,
    block: PromotionBlock,
  ): ShellJobPromotion {
    if (block.kind === "finished") return "already_finished";
    if (block.kind === "stop")
      this.terminate(job, block.reason, block.stopReason);
    return "cancelled_before_commit";
  }

  private promotionCheckpoint(
    job: ShellJob,
    now: number,
  ): ShellJobPromotionPatch {
    return {
      promotedAt: now,
      outputTail: this.tailText(job),
      outputBytes: job.outputBytes,
      outputCheckpointAt: now,
      ...this.outputFilePatch(job),
      noticeState: null,
    };
  }

  async waitForTerminal(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): Promise<ShellJobSnapshot> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const record = this.getOwnedRecord(jobId, sessionId, contextScopeId);
      const result = this.foregroundResults.get(jobId);
      this.foregroundResults.delete(jobId);
      return result?.snapshot ?? this.snapshotRecord(record);
    }
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    if (!isTerminal(job.status)) {
      await job.terminal;
    }
    job.foregroundObserved = true;
    return this.snapshot(job);
  }

  async output(
    jobId: string,
    sessionId: string,
    input: {
      readonly block: boolean;
      readonly signal?: AbortSignal;
      readonly waitMs: number;
      readonly subscribeSteer?: (wake: () => void) => Promise<() => void>;
    },
    contextScopeId?: string,
  ): Promise<ShellJobSnapshot> {
    const record = this.getOwnedRecord(jobId, sessionId, contextScopeId);
    const job = this.jobs.get(jobId);
    const ready = (): boolean =>
      job
        ? job.resultReadyAt !== null
        : this.getOwnedRecord(jobId, sessionId, contextScopeId)
            .resultReadyAt !== null;
    let waitReason: "ready" | "timeout" | "steer" | undefined;
    input.signal?.throwIfAborted();
    if (input.block) {
      waitReason = ready()
        ? "ready"
        : await new Promise<"ready" | "timeout" | "steer">(
            (resolve, reject) => {
              let settled = false;
              let unsubscribeSteer: (() => void) | undefined;
              let poll: ReturnType<typeof setTimeout> | undefined;
              const finish = (
                reason: "ready" | "timeout" | "steer",
                error?: unknown,
              ): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(poll);
                input.signal?.removeEventListener("abort", onAbort);
                job?.resultWaiters.delete(onReady);
                unsubscribeSteer?.();
                if (error)
                  reject(
                    error instanceof Error
                      ? error
                      : new Error("Task output wait failed.", { cause: error }),
                  );
                else resolve(reason);
              };
              const onReady = (): void => {
                finish("ready");
              };
              const onAbort = (): void => {
                finish("timeout", new Error("Task output wait was cancelled."));
              };
              const timer = setTimeout(() => {
                finish("timeout");
              }, input.waitMs);
              if (job) job.resultWaiters.add(onReady);
              else {
                // Only foreign/saved tasks need polling, and only while this read waits.
                const check = (): void => {
                  try {
                    if (ready()) finish("ready");
                    else poll = setTimeout(check, 100);
                  } catch (error) {
                    finish("timeout", error);
                  }
                };
                check();
              }
              if (input.subscribeSteer)
                void input
                  .subscribeSteer(() => {
                    finish("steer");
                  })
                  .then((unsubscribe) => {
                    if (settled) unsubscribe();
                    else unsubscribeSteer = unsubscribe;
                  })
                  .catch((error: unknown) => {
                    finish("steer", error);
                  });
              input.signal?.addEventListener("abort", onAbort, { once: true });
              if (input.signal?.aborted) onAbort();
            },
          );
    }
    const snapshot = job
      ? this.snapshot(job)
      : this.snapshotRecord(
          input.block
            ? this.getOwnedRecord(jobId, sessionId, contextScopeId)
            : record,
        );
    return {
      ...snapshot,
      metadata: { ...snapshot.metadata, ...(waitReason ? { waitReason } : {}) },
    };
  }

  hasLocalHandle(jobId: string): boolean {
    return this.jobs.has(jobId) || this.unspawnedJobs.has(jobId);
  }

  async stopForUser(
    jobId: string,
    sessionId: string,
    contextScopeId: string | undefined,
    beforeAccept?: () => void,
  ): Promise<{ outcome: "accepted" | "already-terminal" }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.getOwnedRecord(jobId, sessionId, contextScopeId);
      if (!this.options.recovery) {
        beforeAccept?.();
        return { outcome: "already-terminal" };
      }
      await this.options.recovery.assertCanManage(jobId);
      const result = await this.options.recovery.recoverForUser(
        jobId,
        beforeAccept,
      );
      if (
        !result.accepted &&
        (result.record.status === null || result.record.status === "running")
      )
        throw new ShellJobManagementError(
          "SHELL_JOB_CLEANUP_BUSY",
          "Task recovery is already in progress; refresh before trying again.",
        );
      return { outcome: result.accepted ? "accepted" : "already-terminal" };
    }
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    beforeAccept?.();
    const accepted = await this.stopLive(job, "user");
    return { outcome: accepted ? "accepted" : "already-terminal" };
  }

  /** Returns whether this call started the termination. */
  private async stopLive(
    job: ShellJob,
    reason: ShellJobStopReason,
  ): Promise<boolean> {
    if (job.cleanup === "unconfirmed") this.observeStopped(job);
    const accepted = !job.terminationStarted && job.cleanup !== "confirmed";
    if (accepted) this.terminate(job, "cancelled", reason);
    await job.terminal;
    return accepted;
  }

  async kill(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
    stopReason: ShellJobStopReason = "model",
  ): Promise<ShellJobSnapshot> {
    const job = this.jobs.get(jobId);
    let snapshot: ShellJobSnapshot;
    let stopResult:
      | "requested"
      | "already_finished"
      | "tracking_released"
      | "cleanup_pending";
    if (job) {
      this.getOwnedJob(jobId, sessionId, contextScopeId);
      const accepted = await this.stopLive(job, stopReason);
      snapshot = this.snapshot(job);
      stopResult = accepted
        ? "requested"
        : job.cleanup === "confirmed" && job.releaseComplete
          ? "already_finished"
          : job.terminationStarted
            ? "requested"
            : "cleanup_pending";
    } else {
      let record = this.getOwnedRecord(jobId, sessionId, contextScopeId);
      let accepted = false;
      if (record.trackingReleasedAt === null && this.options.recovery) {
        await this.options.recovery.assertCanManage(jobId);
        const recovered = await this.options.recovery.recoverForUser(jobId);
        record = recovered.record;
        accepted = recovered.accepted;
      }
      snapshot = this.snapshotRecord(record);
      stopResult =
        record.trackingReleasedAt !== null
          ? "tracking_released"
          : accepted
            ? "requested"
            : isShellJobUnsettled(record)
              ? "cleanup_pending"
              : "already_finished";
    }
    return { ...snapshot, metadata: { ...snapshot.metadata, stopResult } };
  }

  cleanupSession(sessionId: string): Promise<ShellCleanupResult> {
    const filter = inSession(sessionId);
    return this.stopJobs(this.jobsWhere(filter), filter, "session-closed");
  }

  disposeSession(sessionId: string): Promise<void> {
    return this.disposeWhere(inSession(sessionId), "session-closed");
  }

  disposeScope(sessionId: string, contextScopeId: string): Promise<void> {
    return this.disposeWhere(inScope(sessionId, contextScopeId), "owner-ended");
  }

  /** Stop the selected jobs and forget their unread foreground results. */
  private async disposeWhere(
    filter: JobFilter,
    reason: ShellJobStopReason,
  ): Promise<void> {
    await this.disposeJobs(this.jobsWhere(filter), reason);
    if (this.unspawnedWhere(filter).length > 0)
      throw new Error("Shell resource cleanup is unconfirmed");
    for (const [id, result] of this.foregroundResults)
      if (filter(result)) this.foregroundResults.delete(id);
  }

  private async disposeJobs(
    ownedJobs: readonly ShellJob[],
    reason: ShellJobStopReason,
  ): Promise<void> {
    await Promise.all(
      ownedJobs.map(async (job) => {
        if (job.cleanup !== "confirmed")
          this.terminate(job, "cancelled", reason);
        await job.cleanupTask;
        await job.releaseTask;
        this.settle(job);
      }),
    );
  }

  closeAdmission(): void {
    this.admissionClosed = true;
    for (const job of this.jobs.values())
      if (job.cleanup !== "confirmed")
        this.terminate(job, "cancelled", "shutdown");
  }

  async dispose(): Promise<void> {
    this.closeAdmission();
    await Promise.all(
      [...this.jobs.values()].map(async (job) => {
        if (job.cleanup !== "confirmed") this.terminate(job, "cancelled");
        await job.cleanupTask;
        await job.releaseTask;
        if (!job.closed) {
          job.outputFile.finish(false);
          job.outputComplete = false;
          job.child.stdout?.destroy();
          job.child.stderr?.destroy();
          this.persist(job, {
            outputComplete: false,
            outputBytes: job.outputBytes,
            outputTail: job.background ? this.tailText(job) : null,
            ...this.resultReadyPatch(job),
          });
        }
        await job.persist;
      }),
    );
    if (this.unspawnedJobs.size > 0 || this.jobs.size > 0) {
      const cleanup = await this.confirmCleanup(
        [...this.jobs.values()],
        [...this.unspawnedJobs.values()],
      );
      if (
        !cleanup.confirmed &&
        (!cleanup.settled ||
          !(await waitForCleanup(
            cleanup.settled,
            this.options.outputDrainMs ?? SHELL_JOB_TERMINATION_GRACE_MS,
            cleanup.cancelWait,
          )))
      )
        throw new Error("Shell process cleanup is unconfirmed");
    }
  }

  private async persistUnspawned(
    job: UnspawnedJob,
    patch: ShellJobPatch,
  ): Promise<void> {
    job.pendingPatch = { ...job.pendingPatch, ...patch };
    if (job.writing) return;
    job.writing = true;
    try {
      let settledWritten = false;
      while (Object.keys(job.pendingPatch).length > 0) {
        const pending = job.pendingPatch;
        job.pendingPatch = {};
        try {
          await this.store.update(job.jobId, pending);
          if (pending.settledAt !== undefined && pending.settledAt !== null)
            settledWritten = true;
        } catch (error) {
          job.pendingPatch = { ...pending, ...job.pendingPatch };
          throw error;
        }
      }
      if (job.releaseComplete) {
        if (!settledWritten) {
          const settledAt = Date.now();
          try {
            await this.store.update(job.jobId, { settledAt });
          } catch (error) {
            job.pendingPatch = { ...job.pendingPatch, settledAt };
            throw error;
          }
        }
        this.unspawnedJobs.delete(job.jobId);
        for (const resolve of job.waiters) resolve();
        job.waiters.clear();
      }
    } catch (error) {
      this.scheduleCheckpoint();
      try {
        job.reportCleanupError?.(error);
      } catch {
        /* Observer does not own cleanup. */
      }
    } finally {
      job.writing = false;
    }
  }

  private persist(job: ShellJob, patch: ShellJobPatch): void {
    job.persist = job.persist
      .catch(() => undefined)
      .then(async () => {
        const pending = { ...job.pendingPatch, ...patch };
        job.pendingPatch = {};
        try {
          await this.store.update(job.jobId, pending);
        } catch (error) {
          job.pendingPatch = { ...pending, ...job.pendingPatch };
          this.scheduleCheckpoint();
          job.reportCleanupError?.(error);
          if (patch.status === "running" && !job.terminationStarted)
            this.terminate(job, "cancelled", "owner-ended");
          throw error;
        }
      });
    void job.persist.catch(() => undefined);
  }

  private resultReadyPatch(job: ShellJob): ShellJobPatch {
    if (job.resultReadyAt !== null) return {};
    job.resultReadyAt = Date.now();
    for (const waiter of job.resultWaiters) waiter();
    job.resultWaiters.clear();
    return {
      resultReadyAt: job.resultReadyAt,
      noticeState: initialShellJobNoticeState({
        mode: job.background ? "background" : "foreground",
        status: job.status,
        stopReason: job.stopReason,
        contextScopeId: job.contextScopeId ?? null,
      }),
    };
  }

  private outputFilePatch(
    job: ShellJob,
  ): Pick<ShellJobPatch, "outputPath" | "outputTruncated"> {
    const file = job.outputFile.snapshot();
    return {
      outputPath: file.status === "unavailable" ? null : file.path,
      outputTruncated:
        file.status === "partial" && file.reason === "size-limit",
    };
  }

  private tailText(job: ShellJob): string {
    // Keep incomplete trailing bytes for the next chunk; checkpoints expose only
    // valid UTF-8 rather than writing a replacement character prematurely.
    return new TextDecoder("utf-8").decode(job.tail, { stream: true });
  }

  private scheduleCheckpoint(): void {
    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      for (const job of this.unspawnedJobs.values()) {
        if (Object.keys(job.pendingPatch).length > 0)
          void this.persistUnspawned(job, {});
      }
      for (const job of this.jobs.values()) {
        if (job.closed && Object.keys(job.pendingPatch).length > 0) {
          if (
            !job.settling &&
            job.cleanup === "confirmed" &&
            job.releaseComplete &&
            !job.identityPending
          )
            this.settle(job);
          else if (!job.settling) this.persist(job, {});
        } else if (
          job.background &&
          !job.closed &&
          job.outputBytes !== job.checkpointBytes
        ) {
          job.checkpointBytes = job.outputBytes;
          this.persist(job, {
            ...this.outputFilePatch(job),
            outputBytes: job.outputBytes,
            outputTail: this.tailText(job),
            outputCheckpointAt: Date.now(),
          });
        } else if (Object.keys(job.pendingPatch).length > 0) {
          this.persist(job, {});
        }
      }
    }, 1000);
    this.checkpointTimer.unref();
  }

  private capture(job: ShellJob, chunk: unknown): void {
    job.outputFile.append(chunk);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    job.outputBytes += bytes.length;
    if (job.background) this.scheduleCheckpoint();
    const tail = Buffer.concat([job.tail, bytes]);
    let start = Math.max(0, tail.length - 32 * 1024);
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    job.tail = Buffer.from(tail.subarray(start));
    if (
      job.outputBytes >= (this.options.maxOutputBytes ?? 1024 * 1024 * 1024) &&
      !job.terminationStarted
    ) {
      this.terminate(job, "cancelled", "output-limit");
    }
  }

  private settle(job: ShellJob): void {
    if (
      !job.closed ||
      job.closing ||
      job.cleanup !== "confirmed" ||
      !job.releaseComplete ||
      job.identityPending ||
      job.settling ||
      !isTerminal(job.status)
    )
      return;
    job.settling = true;
    this.persist(job, { settledAt: Date.now(), ...this.outputFilePatch(job) });
    void job.persist
      .then(() => {
        if (job.closed && job.cleanup === "confirmed" && job.releaseComplete) {
          if (!job.background && !job.foregroundObserved) {
            this.foregroundResults.set(job.jobId, {
              snapshot: this.snapshot(job),
              sessionId: job.sessionId,
              contextScopeId: job.contextScopeId,
            });
          }
          this.jobs.delete(job.jobId);
          for (const resolve of job.confirmationWaiters ?? []) resolve();
          job.confirmationWaiters?.clear();
        }
      })
      .catch(() => {
        job.settling = false;
      });
  }

  private getOwnedRecord(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): ShellJobRecord {
    const record = this.store.get(jobId);
    if (
      record?.sessionId !== sessionId ||
      record.contextScopeId !== (contextScopeId ?? null)
    )
      throw new ToolParameterError(
        `Shell job "${jobId}" is unavailable in this session/context scope.`,
      );
    return record;
  }

  private snapshotRecord(record: ShellJobRecord): ShellJobSnapshot {
    if (!record.status)
      throw new ToolParameterError(`Shell job "${record.jobId}" is starting.`);
    const truncated =
      record.outputTruncated ||
      (record.outputTail !== null &&
        record.outputBytes > Buffer.byteLength(record.outputTail, "utf8"));
    const output =
      record.outputTail ??
      (record.mode === "foreground"
        ? "Output tail is not retained for foreground jobs."
        : "No output tail is available.");
    let outputFile:
      | {
          status: "full" | "partial";
          path: string;
          sizeBytes: number;
          reason?: "size-limit" | "stdio-incomplete";
        }
      | undefined;
    if (record.outputPath) {
      try {
        const stat = fs.statSync(record.outputPath);
        if (stat.isFile())
          outputFile = {
            status:
              record.outputTruncated || record.outputComplete === false
                ? "partial"
                : "full",
            path: record.outputPath,
            sizeBytes: stat.size,
            ...(record.outputTruncated
              ? { reason: "size-limit" as const }
              : record.outputComplete === false
                ? { reason: "stdio-incomplete" as const }
                : {}),
          };
      } catch {
        /* A disappeared or inaccessible log must not be advertised. */
      }
    }
    return {
      jobId: record.jobId,
      status: record.status,
      output,
      truncated,
      exitCode: record.exitCode,
      signal: record.signal as NodeJS.Signals | null,
      metadata: {
        jobId: record.jobId,
        command: record.command,
        description: record.description,
        mode: record.mode,
        truncated,
        promotedAt: record.promotedAt,
        timeoutMs: record.timeoutMs,
        deadline:
          record.startedAt !== null && record.timeoutMs !== null
            ? record.startedAt + record.timeoutMs
            : null,
        status: record.status,
        cleanup: record.cleanup,
        stopReason: record.stopReason,
        tailAvailable:
          record.mode === "background" && record.outputTail !== null,
        resultReadyAt: record.resultReadyAt,
        settledAt: record.settledAt,
        trackingReleasedAt: record.trackingReleasedAt,
        outputBytes: record.outputBytes,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        outputComplete: record.outputComplete,
        outputCheckpointAt: record.outputCheckpointAt,
        outputFile,
        exitCode: record.exitCode,
        signal: record.signal,
      },
    };
  }

  private getOwnedJob(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): ShellJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ToolParameterError(
        `Shell job "${jobId}" is unavailable in this session/context scope.`,
      );
    }
    if (job.sessionId !== sessionId || job.contextScopeId !== contextScopeId) {
      throw new ToolParameterError(
        `Shell job "${jobId}" is unavailable in this session/context scope.`,
      );
    }
    return job;
  }

  private snapshot(job: ShellJob): ShellJobSnapshot {
    const rendered = renderOutput(job);
    const outputFile = job.outputFile.snapshot(
      job.terminationReason !== undefined,
    );
    const metadata = {
      ...job.metadata,
      mode: job.background ? "background" : "foreground",
      promotedAt: job.promotedAt,
      timeoutMs: job.timeoutMs,
      deadline: job.timeoutMs === null ? null : job.startedAt + job.timeoutMs,
      tailAvailable: job.background,
      resultReadyAt: job.resultReadyAt,
      outputBytes: job.outputBytes,
      startedAt: job.startedAt,
      outputComplete: job.outputComplete,
      stopReason: job.stopReason,
      jobId: job.jobId,
      status: job.status,
      truncated: rendered.truncated,
      outputFile,
      ...(job.cleanup ? { cleanup: job.cleanup } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(isTerminal(job.status)
        ? { exitCode: job.exitCode ?? null, signal: job.signal ?? null }
        : {}),
    };
    return {
      jobId: job.jobId,
      metadata,
      output: rendered.truncated
        ? `${rendered.output}\n\n${outputFileNotice(outputFile)}`
        : rendered.output,
      status: job.status,
      truncated: rendered.truncated,
      ...(isTerminal(job.status)
        ? { exitCode: job.exitCode ?? null, signal: job.signal ?? null }
        : {}),
    };
  }

  private finishFromChild(
    job: ShellJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.terminationReason !== undefined) {
      this.finish(job, job.terminationReason, exitCode, signal);
      return;
    }
    if (job.error) {
      this.finish(job, "failed", exitCode, signal);
      return;
    }
    this.finish(job, exitCode === 0 ? "completed" : "failed", exitCode, signal);
  }

  private finish(
    job: ShellJob,
    status: Exclude<ShellJobStatus, "running">,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (isTerminal(job.status)) {
      return;
    }
    if (job.terminationStarted || job.cleanup === "confirmed")
      clearTimeout(job.timeoutId);
    if (job.closed && job.outputDrain) clearTimeout(job.outputDrain);
    job.status = status;
    job.exitCode = exitCode;
    job.signal = signal;
    job.resolveTerminal();
    this.persist(job, {
      status,
      exitCode,
      signal,
      error: job.error ?? null,
      stopReason: job.stopReason,
      ...(job.closed
        ? {
            outputComplete: job.outputComplete,
            ...this.resultReadyPatch(job),
            outputBytes: job.outputBytes,
            outputTail: job.background ? this.tailText(job) : null,
            outputCheckpointAt: job.background ? Date.now() : null,
          }
        : {}),
    });
  }

  private observeStopped(job: ShellJob): void {
    if (job.cleanup === "confirmed") return;
    let state: ProcessTreeState;
    try {
      state =
        this.options.probeTree?.(job.child) ??
        probeProcessTree(job.child, {
          exited: () => job.exited,
          terminationSucceeded: job.terminationSucceeded,
        });
    } catch {
      state = "unknown";
    }
    if (state === "stopped") this.confirmStopped(job);
    // An uncertain event probe is not the end of the terminator observation.
    // Only its authoritative result (or the legacy helper budget) ends that wait.
  }

  private confirmStopped(job: ShellJob): void {
    if (job.cleanup === "confirmed") return;
    const hadUnconfirmedCleanup = job.cleanup === "unconfirmed";
    job.cleanup = "confirmed";
    clearTimeout(job.timeoutId);
    if (job.observation) clearTimeout(job.observation);
    job.resolveCleanup?.();
    job.sourceCleanup?.confirm();
    if (job.terminationStarted || hadUnconfirmedCleanup)
      job.reportCleanup?.("confirmed");
    const released = (): void => {
      job.releaseComplete = true;
      this.settle(job);
    };
    if (job.release)
      job.releaseTask = Promise.resolve()
        .then(job.release)
        .then(released)
        .catch((error: unknown) => {
          // Process exit is confirmed, but the retained sandbox resource is not.
          // Keep releaseComplete false: a failed one-shot release cannot safely be retried.
          try {
            job.reportCleanupError?.(error);
          } catch {
            /* Observers do not own cleanup. */
          }
        });
    else released();
    if (job.closed)
      this.finishFromChild(job, job.exitCode ?? null, job.signal ?? null);
    else {
      job.outputDrain = setTimeout(() => {
        job.outputFile.finish(false);
        job.outputComplete = false;
        job.child.stdout?.destroy();
        job.child.stderr?.destroy();
        this.finishFromChild(job, job.exitCode ?? null, job.signal ?? null);
        this.persist(job, {
          outputComplete: false,
          ...this.outputFilePatch(job),
          ...this.resultReadyPatch(job),
          outputBytes: job.outputBytes,
          outputTail: job.background ? this.tailText(job) : null,
          outputCheckpointAt: job.background ? Date.now() : null,
        });
      }, this.options.outputDrainMs ?? SHELL_JOB_TERMINATION_GRACE_MS);
      job.outputDrain.unref();
    }
    this.persist(job, { cleanup: "confirmed" });
    this.settle(job);
  }

  private markUnconfirmed(job: ShellJob): void {
    if (job.cleanup === "confirmed" || job.cleanup === "unconfirmed") return;
    job.cleanup = "unconfirmed";
    this.persist(job, {
      cleanup: "unconfirmed",
      outputComplete: false,
      ...this.outputFilePatch(job),
      ...this.resultReadyPatch(job),
      outputBytes: job.outputBytes,
      outputTail: job.background ? this.tailText(job) : null,
    });
    if (job.observation) clearTimeout(job.observation);
    job.sourceCleanup?.markUnconfirmed();
    job.reportCleanup?.("unconfirmed");
    job.resolveCleanup?.();
  }

  private terminate(
    job: ShellJob,
    reason: TerminationReason,
    stopReason: ShellJobStopReason = "model",
  ): void {
    if (job.terminationStarted || job.cleanup === "confirmed") return;
    job.terminationStarted = true;
    clearTimeout(job.timeoutId);
    job.terminationReason = reason;
    const alreadyTerminal = isTerminal(job.status);
    if (!alreadyTerminal)
      job.stopReason = reason === "timed_out" ? "timeout" : stopReason;
    job.cleanup = "in-progress";
    this.persist(job, {
      ...(!alreadyTerminal
        ? { status: reason, stopReason: job.stopReason }
        : {}),
      cleanup: "in-progress",
    });
    if (job.owner) job.sourceCleanup = beginSourceCleanup(job.owner);
    job.reportCleanup?.("in-progress");
    job.cleanupTask = new Promise<void>((resolve) => {
      job.resolveCleanup = resolve;
    });
    // Stop intent is durable before signalling. Keep the process and lease managed
    // if the write fails; a failed commit is not evidence of cleanup.
    const signalProcess = (): void => {
      if (!this.options.terminationManagesObservation) {
        job.observation = setTimeout(() => {
          this.markUnconfirmed(job);
        }, this.options.cleanupObservationMs ?? 1200);
        job.observation.unref();
      }
      try {
        const termination = this.killTree(job.child);
        void Promise.resolve(termination).then(
          (result) => {
            if (result?.terminationSucceeded) job.terminationSucceeded = true;
            if (result?.status === "confirmed") this.confirmStopped(job);
            else if (result?.status === "unconfirmed")
              this.markUnconfirmed(job);
            else this.observeStopped(job);
          },
          () => {
            this.markUnconfirmed(job);
          },
        );
      } catch {
        this.markUnconfirmed(job);
      }
    };
    void job.persist.then(signalProcess, signalProcess);
    this.finish(job, reason, job.exitCode ?? null, job.signal ?? null);
  }
}
