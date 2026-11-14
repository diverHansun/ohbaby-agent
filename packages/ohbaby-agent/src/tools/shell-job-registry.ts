import type { ProcessIdentity } from "../shell/process-identity.js";
import fs from "node:fs";
import {
  shellJobStatusLine,
  initialShellJobNoticeState,
} from "./shell-job-notice.js";
import {
  InMemoryShellJobStore,
  type ShellJobStore,
  type ShellJobRecord,
  type ShellJobPatch,
  type ShellJobStopReason,
} from "./shell-job-store.js";
import type {
  RunCleanupSnapshot,
  ToolCleanupState,
} from "../core/tool-scheduler/run-cleanup.js";
import {
  probeProcessTree,
  type KillTreeResult,
  type ProcessTreeState,
} from "../shell/process.js";
import { beginSourceCleanup } from "../core/tool-scheduler/source-cleanup.js";
import type { ToolExecutionOwner } from "../core/tool-scheduler/types.js";
import { withToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CappedOutputFile,
  outputFileNotice,
} from "../utils/capped-output-file.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { DEFAULT_OUTPUT_TOKEN_LIMIT, truncateOutput } from "./utils/output.js";
import {
  getNumberParam,
  getRequiredNonEmptyStringParam,
  ToolParameterError,
} from "./utils/params.js";

export const DEFAULT_SHELL_JOB_TIMEOUT_MS = 120_000;
export const MAX_SHELL_JOB_TIMEOUT_MS = 600_000;
export const DEFAULT_TASK_OUTPUT_WAIT_MS = 30_000;
export const OUTPUT_CAPTURE_CHAR_LIMIT = DEFAULT_OUTPUT_TOKEN_LIMIT * 4 + 1;
export const SHELL_JOB_TERMINATION_GRACE_MS = 1_000;

export type ShellJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "lost";

type TerminationReason = "cancelled" | "timed_out";

export interface ShellJobStartInput {
  /** Already prepared by the caller; the registry owns only jobId.log and capture. */
  readonly outputDirectory?: string;
  readonly background?: boolean;
  readonly signal?: AbortSignal;
  /** Called once the reservation is committed and registry owns the release. */
  readonly onReserved?: () => void;
  readonly child: ChildProcess | (() => ChildProcess);
  readonly owner?: ToolExecutionOwner;
  readonly release?: () => void | Promise<void>;
  readonly reportCleanupError?: (error: unknown) => void;
  readonly reportCleanup?: (state: ToolCleanupState) => void;
  readonly captureMode?: "head" | "tail";
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
  tail: Buffer;
  persist: Promise<void>;
  pendingPatch: ShellJobPatch;
  identityPending: boolean;
  settling: boolean;
  resultPublished: boolean;
  foregroundObserved: boolean;
  outputComplete: boolean | null;
  stopReason: ShellJobStopReason | null;
  readonly background: boolean;
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
  observation?: ReturnType<typeof setTimeout>;
  outputDrain?: ReturnType<typeof setTimeout>;
  closed: boolean;
  closing: boolean;
  exited: boolean;
  terminationSucceeded: boolean;
  readonly child: ChildProcess;
  readonly captureMode: "head" | "tail";
  readonly contextScopeId?: string;
  readonly jobId: string;
  readonly startedAt: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  output: string;
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

function appendTail(
  current: string,
  chunk: string,
): { readonly output: string; readonly truncated: boolean } {
  const next = current + chunk;
  if (next.length <= OUTPUT_CAPTURE_CHAR_LIMIT) {
    return { output: next, truncated: false };
  }
  return {
    output: next.slice(-OUTPUT_CAPTURE_CHAR_LIMIT),
    truncated: true,
  };
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
    return `Command failed to start: ${job.error}`;
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
  if (job.captureMode === "head") {
    const combined = [job.stdout.trimEnd(), job.stderr.trimEnd()]
      .filter((part) => part.length > 0)
      .join("\n");
    const baseOutput = combined || emptyOutputMessage(job);
    const output = truncateOutput(baseOutput);
    return { output, truncated: job.truncated || output !== baseOutput };
  }

  const output = job.output.trimEnd();
  if (output.length === 0) {
    return { output: emptyOutputMessage(job), truncated: job.truncated };
  }
  return {
    output: job.truncated ? `${output}\n\n... [results truncated]` : output,
    truncated: job.truncated,
  };
}

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
  private readonly sealedRoots = new Set<string>();
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
    if (
      typeof input.child === "function" &&
      (this.admissionClosed ||
        (input.owner?.rootRunId !== undefined &&
          this.sealedRoots.has(input.owner.rootRunId)))
    )
      throw new Error("Shell root run is closed.");
    const now = Date.now();
    const identity = this.options.readProcessIdentity
      ? await (this.ownerIdentity ??= this.options.readProcessIdentity(
          process.pid,
        ))
      : undefined;
    const owner = input.owner;
    const record: ShellJobRecord = {
      jobId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId ?? null,
      rootSessionId: owner?.rootSessionId ?? input.sessionId,
      rootRunId: owner?.rootRunId ?? null,
      runId: owner?.runId ?? null,
      messageId: owner?.messageId ?? null,
      callId: owner?.callId ?? null,
      mode: input.background ? "background" : "foreground",
      command:
        typeof input.metadata?.command === "string"
          ? input.metadata.command
          : "",
      description:
        typeof input.metadata?.description === "string"
          ? input.metadata.description
          : null,
      cwd: typeof input.metadata?.cwd === "string" ? input.metadata.cwd : "",
      shell:
        typeof input.metadata?.shell === "string" ? input.metadata.shell : "",
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
      ownerStartToken:
        identity?.state === "present" ? identity.startToken : null,
      goalId: null,
      createdAt: now,
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
    const assertAdmitted = (): undefined => {
      if (typeof input.child !== "function") return undefined;
      if (input.signal?.aborted) throw new Error("Command was cancelled.");
      if (
        this.admissionClosed ||
        (owner?.rootRunId !== undefined &&
          this.sealedRoots.has(owner.rootRunId))
      )
        throw new Error("Shell root run is closed.");
      return undefined;
    };
    await this.store.insert(record, { assertAdmitted });
    input.onReserved?.();
    let child: ChildProcess;
    let cancelledBeforeSpawn = false;
    try {
      if (typeof input.child === "function") {
        cancelledBeforeSpawn =
          input.signal?.aborted === true ||
          this.admissionClosed ||
          (owner?.rootRunId !== undefined &&
            this.sealedRoots.has(owner.rootRunId));
        assertAdmitted();
      }
      child = typeof input.child === "function" ? input.child() : input.child;
    } catch (error) {
      cancelledBeforeSpawn ||= input.signal?.aborted === true;
      const pending: UnspawnedJob = {
        jobId,
        sessionId: input.sessionId,
        contextScopeId: input.contextScopeId,
        rootRunId: owner?.rootRunId,
        background: input.background ?? false,
        reportCleanupError: input.reportCleanupError,
        pendingPatch: {},
        writing: false,
        releaseComplete: false,
        waiters: new Set(),
      };
      this.unspawnedJobs.set(jobId, pending);
      await this.persistUnspawned(pending, {
        status: cancelledBeforeSpawn ? "cancelled" : "failed",
        stopReason: cancelledBeforeSpawn
          ? input.signal?.aborted
            ? "user"
            : "owner-ended"
          : null,
        error: cancelledBeforeSpawn
          ? null
          : error instanceof Error
            ? error.message
            : String(error),
        cleanup: "confirmed",
        outputComplete: true,
        noticeState:
          input.background && !cancelledBeforeSpawn ? "pending" : "suppressed",
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
      throw error;
    }
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
      tail: Buffer.alloc(0),
      persist: Promise.resolve(),
      pendingPatch: {},
      identityPending: Boolean(child.pid && this.options.readProcessIdentity),
      settling: false,
      resultPublished: false,
      foregroundObserved: false,
      outputComplete: null,
      stopReason: null,
      background: input.background ?? false,
      releaseComplete: false,
      owner: input.owner,
      release: input.release,
      reportCleanup: input.reportCleanup,
      reportCleanupError: input.reportCleanupError,
      closed: false,
      closing: false,
      exited: false,
      terminationSucceeded: false,
      captureMode: input.captureMode ?? "tail",
      contextScopeId: input.contextScopeId,
      jobId,
      startedAt: Date.now(),
      metadata: { ...input.metadata, pid: child.pid },
      output: "",
      stderr: "",
      stdout: "",
      resolveTerminal,
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
    this.jobs.set(job.jobId, job);
    this.persist(job, {
      status: "running",
      startedAt: job.startedAt,
      pid: child.pid ?? null,
      pgid: process.platform !== "win32" ? (child.pid ?? null) : null,
    });

    child.stdout?.on("data", (chunk: unknown) => {
      this.capture(job, chunk);
      const next =
        job.captureMode === "tail"
          ? appendTail(job.output, chunkToString(chunk))
          : appendHead(job.stdout, chunkToString(chunk));
      if (job.captureMode === "tail") {
        job.output = next.output;
      } else {
        job.stdout = next.output;
      }
      job.truncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: unknown) => {
      this.capture(job, chunk);
      const next =
        job.captureMode === "tail"
          ? appendTail(job.output, chunkToString(chunk))
          : appendHead(job.stderr, chunkToString(chunk));
      if (job.captureMode === "tail") {
        job.output = next.output;
      } else {
        job.stderr = next.output;
      }
      job.truncated ||= next.truncated;
    });
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

    try {
      child.stdin?.end();
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      this.terminate(job, "cancelled");
    }
    // A caller can supply an already launched process, or Stop can run inside spawn.
    // Register its cleanup owner before terminating it; never abandon the process.
    if (
      this.admissionClosed ||
      (job.owner?.rootRunId !== undefined &&
        this.sealedRoots.has(job.owner.rootRunId))
    )
      this.terminate(job, "cancelled");
    if (child.pid && this.options.readProcessIdentity) {
      try {
        const processIdentity = await this.options.readProcessIdentity(
          child.pid,
        );
        if (processIdentity.state === "present")
          this.persist(job, {
            pgid: processIdentity.pgid,
            processStartToken: processIdentity.startToken,
          });
      } catch (error) {
        job.reportCleanupError?.(error);
      } finally {
        job.identityPending = false;
        this.settle(job);
      }
    }
    try {
      await job.persist;
    } catch {
      // The process already exists. Keep its cleanup owner and terminate it;
      // throwing here would make bash release resources while it is still alive.
      this.terminate(job, "cancelled", "owner-ended");
    }
    return this.snapshot(job);
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

  hasActiveWork(rootRunId?: string): boolean {
    return (
      [...this.jobs.values()].some(
        (job) => rootRunId === undefined || job.owner?.rootRunId === rootRunId,
      ) ||
      [...this.unspawnedJobs.values()].some(
        (job) => rootRunId === undefined || job.rootRunId === rootRunId,
      )
    );
  }

  /** Signal cancellation immediately; the registry retains each job's cleanup task and lease. */
  sealRootRun(rootRunId: string): void {
    this.sealedRoots.add(rootRunId);
  }

  cancelByRootRun(rootRunId: string): readonly ShellJobSnapshot[] {
    this.sealedRoots.add(rootRunId);
    const jobs = [...this.jobs.values()].filter(
      (job) => job.owner?.rootRunId === rootRunId,
    );
    for (const job of jobs)
      if (job.cleanup !== "confirmed") this.terminate(job, "cancelled");
    return jobs.map((job) => this.snapshot(job));
  }

  async cleanupRootRun(rootRunId: string): Promise<ShellCleanupResult> {
    this.cancelByRootRun(rootRunId);
    return this.confirmCleanup(
      [...this.jobs.values()].filter(
        (job) => job.owner?.rootRunId === rootRunId,
      ),
      [...this.unspawnedJobs.values()].filter(
        (job) => job.rootRunId === rootRunId,
      ),
    );
  }

  /** Natural completion exempts only explicitly detached shell jobs. */
  observeExecutionCleanup(rootRunId: string): Promise<ShellCleanupResult> {
    return this.confirmCleanup(
      [...this.jobs.values()].filter(
        (job) => job.owner?.rootRunId === rootRunId && !job.background,
      ),
      [...this.unspawnedJobs.values()].filter(
        (job) => job.rootRunId === rootRunId && !job.background,
      ),
    );
  }

  async cleanupScope(
    sessionId: string,
    contextScopeId: string,
  ): Promise<ShellCleanupResult> {
    const jobs = [...this.jobs.values()].filter(
      (job) =>
        job.sessionId === sessionId && job.contextScopeId === contextScopeId,
    );
    await this.disposeJobs(jobs, "owner-ended");
    return this.confirmCleanup(
      jobs,
      [...this.unspawnedJobs.values()].filter(
        (job) =>
          job.sessionId === sessionId && job.contextScopeId === contextScopeId,
      ),
    );
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
    return {
      confirmed: false,
      settled: Promise.all([
        ...pending.map(
          (job) =>
            new Promise<void>((resolve) => {
              (job.confirmationWaiters ??= new Set()).add(resolve);
            }),
        ),
        ...pendingUnspawned.map(
          (job) =>
            new Promise<void>((resolve) => {
              job.waiters.add(resolve);
            }),
        ),
      ]).then(() => undefined),
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
    },
    contextScopeId?: string,
  ): Promise<ShellJobSnapshot> {
    const job = this.jobs.get(jobId);
    if (!job)
      return this.snapshotRecord(
        this.getOwnedRecord(jobId, sessionId, contextScopeId),
      );
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    if (input.block && !isTerminal(job.status)) {
      if (input.signal?.aborted) {
        throw new Error("Task output wait was cancelled.");
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abortHandler);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const abortHandler = (): void => {
          finish(new Error("Task output wait was cancelled."));
        };
        const timer = setTimeout(() => {
          finish();
        }, input.waitMs);
        void job.terminal.then(() => {
          finish();
        });
        input.signal?.addEventListener("abort", abortHandler, { once: true });
      });
    }
    return this.snapshot(job);
  }

  async kill(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
    stopReason: ShellJobStopReason = "model",
  ): Promise<ShellJobSnapshot> {
    const job = this.jobs.get(jobId);
    if (!job)
      return this.snapshotRecord(
        this.getOwnedRecord(jobId, sessionId, contextScopeId),
      );
    this.getOwnedJob(jobId, sessionId, contextScopeId);
    if (job.cleanup !== "confirmed") {
      this.terminate(job, "cancelled", stopReason);
    }
    await job.terminal;
    return this.snapshot(job);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const ownedJobs = [...this.jobs.values()].filter(
      (job) => job.sessionId === sessionId,
    );
    await this.disposeJobs(ownedJobs, "session-closed");
    if (
      [...this.unspawnedJobs.values()].some(
        (job) => job.sessionId === sessionId,
      )
    )
      throw new Error("Shell resource cleanup is unconfirmed");
    for (const [id, result] of this.foregroundResults)
      if (result.sessionId === sessionId) this.foregroundResults.delete(id);
  }

  async disposeScope(sessionId: string, contextScopeId: string): Promise<void> {
    const ownedJobs = [...this.jobs.values()].filter(
      (job) =>
        job.sessionId === sessionId && job.contextScopeId === contextScopeId,
    );
    await this.disposeJobs(ownedJobs, "owner-ended");
    if (
      [...this.unspawnedJobs.values()].some(
        (job) =>
          job.sessionId === sessionId && job.contextScopeId === contextScopeId,
      )
    )
      throw new Error("Shell resource cleanup is unconfirmed");
    for (const [id, result] of this.foregroundResults)
      if (
        result.sessionId === sessionId &&
        result.contextScopeId === contextScopeId
      )
        this.foregroundResults.delete(id);
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
    if (
      this.unspawnedJobs.size > 0 ||
      [...this.jobs.values()].some(
        (job) =>
          job.cleanup !== "confirmed" ||
          !job.releaseComplete ||
          (job.closed &&
            (job.settling || Object.keys(job.pendingPatch).length > 0)),
      )
    )
      throw new Error("Shell process cleanup is unconfirmed");
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
    if (job.resultPublished) return {};
    job.resultPublished = true;
    return {
      resultReadyAt: Date.now(),
      noticeState: initialShellJobNoticeState({
        mode: job.background ? "background" : "foreground",
        status: job.status,
        stopReason: job.stopReason,
        contextScopeId: job.contextScopeId ?? null,
      }),
    };
  }

  private outputFilePatch(job: ShellJob): ShellJobPatch {
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
        } else if (job.background && !job.closed) {
          this.persist(job, {
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
    if (!record) throw new ToolParameterError(`Unknown shell job "${jobId}".`);
    if (
      record.sessionId !== sessionId ||
      record.contextScopeId !== (contextScopeId ?? null)
    )
      throw new ToolParameterError(
        `Shell job "${jobId}" is not owned by this session/context scope.`,
      );
    return record;
  }

  private snapshotRecord(record: ShellJobRecord): ShellJobSnapshot {
    if (!record.status)
      throw new ToolParameterError(`Shell job "${record.jobId}" is starting.`);
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
      truncated: record.outputTruncated,
      exitCode: record.exitCode,
      signal: record.signal as NodeJS.Signals | null,
      metadata: {
        jobId: record.jobId,
        status: record.status,
        cleanup: record.cleanup,
        stopReason: record.stopReason,
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
      throw new ToolParameterError(`Unknown shell job "${jobId}".`);
    }
    if (job.sessionId !== sessionId || job.contextScopeId !== contextScopeId) {
      throw new ToolParameterError(
        `Shell job "${jobId}" is not owned by this session/context scope.`,
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
    job.cleanup = "confirmed";
    clearTimeout(job.timeoutId);
    if (job.observation) clearTimeout(job.observation);
    job.resolveCleanup?.();
    job.sourceCleanup?.confirm();
    if (job.terminationStarted) job.reportCleanup?.("confirmed");
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

function snapshotResult(
  snapshot: ShellJobSnapshot,
  includeStatus = false,
): ToolExecutionResult {
  if (!includeStatus)
    return { metadata: snapshot.metadata, output: snapshot.output };
  const file = snapshot.metadata.outputFile as
    | { status?: string; path?: string }
    | undefined;
  let path: string | null = null;
  if (file?.status !== "unavailable" && file?.path) {
    try {
      if (fs.statSync(file.path).isFile()) path = file.path;
    } catch {
      /* unavailable */
    }
  }
  const line = shellJobStatusLine({
    status: snapshot.status,
    outputBytes:
      typeof snapshot.metadata.outputBytes === "number"
        ? snapshot.metadata.outputBytes
        : null,
    outputComplete:
      typeof snapshot.metadata.outputComplete === "boolean"
        ? snapshot.metadata.outputComplete
        : null,
    outputCheckpointAt:
      typeof snapshot.metadata.outputCheckpointAt === "number"
        ? snapshot.metadata.outputCheckpointAt
        : null,
    outputPath: path,
    stopReason:
      typeof snapshot.metadata.stopReason === "string"
        ? snapshot.metadata.stopReason
        : null,
    elapsedMs:
      typeof snapshot.metadata.startedAt === "number"
        ? Math.max(
            0,
            (typeof snapshot.metadata.endedAt === "number"
              ? snapshot.metadata.endedAt
              : Date.now()) - snapshot.metadata.startedAt,
          )
        : null,
    cleanup:
      typeof snapshot.metadata.cleanup === "string"
        ? snapshot.metadata.cleanup
        : null,
  });
  return { metadata: snapshot.metadata, output: `${line}\n${snapshot.output}` };
}

export function createTaskOutputTool(registry: ShellJobRegistry): Tool {
  return withToolAdmission(
    {
      annotations: { readOnlyHint: true },
      category: "subagent-control",
      description:
        "Read a shell job's current bounded tail-output snapshot. With block=true, wait up to wait_ms for the job to finish; wait_ms only limits this read and never changes the bash job timeout.",
      name: "task_output",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: {
          block: { default: false, type: "boolean" },
          job_id: { type: "string" },
          wait_ms: {
            default: DEFAULT_TASK_OUTPUT_WAIT_MS,
            maximum: MAX_SHELL_JOB_TIMEOUT_MS,
            minimum: 1,
            type: "integer",
          },
        },
        required: ["job_id"],
        type: "object",
      },
      source: "builtin",
      timeoutOwner: "tool",
      async execute(params, context): Promise<ToolExecutionResult> {
        const block = params.block ?? false;
        if (typeof block !== "boolean") {
          throw new ToolParameterError(
            'Expected parameter "block" to be a boolean.',
          );
        }
        const waitMs = getNumberParam(params, "wait_ms", {
          defaultValue: DEFAULT_TASK_OUTPUT_WAIT_MS,
          integer: true,
          max: MAX_SHELL_JOB_TIMEOUT_MS,
          min: 1,
        });
        return snapshotResult(
          await registry.output(
            getRequiredNonEmptyStringParam(params, "job_id"),
            context.sessionId,
            { block, signal: context.signal, waitMs },
            context.contextScopeId,
          ),
          true,
        );
      },
    },
    { capacity: "control", plan: () => [] },
  );
}

export function createTaskKillTool(registry: ShellJobRegistry): Tool {
  return withToolAdmission(
    {
      category: "subagent-control",
      description:
        "Cancel a running shell job (stop/kill are equivalent). A cancelled job is distinct from an automatically timed_out job; killing an already terminal job is idempotent.",
      name: "task_kill",
      parametersJsonSchema: {
        additionalProperties: false,
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        type: "object",
      },
      source: "builtin",
      timeoutOwner: "tool",
      async execute(params, context): Promise<ToolExecutionResult> {
        return snapshotResult(
          await registry.kill(
            getRequiredNonEmptyStringParam(params, "job_id"),
            context.sessionId,
            context.contextScopeId,
          ),
        );
      },
    },
    { capacity: "control", plan: () => [] },
  );
}
