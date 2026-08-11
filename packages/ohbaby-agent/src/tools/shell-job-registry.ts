import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
export const MAX_RETAINED_SHELL_JOBS = 100;

export type ShellJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

type TerminationReason = "cancelled" | "timed_out";

export interface ShellJobStartInput {
  readonly child: ChildProcess;
  readonly captureMode?: "head" | "tail";
  readonly contextScopeId?: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
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

export interface ShellJobRegistryOptions {
  readonly killTree: (child: ChildProcess) => Promise<void> | void;
  readonly createJobId?: () => string;
}

interface ShellJob {
  readonly child: ChildProcess;
  readonly captureMode: "head" | "tail";
  readonly contextScopeId?: string;
  readonly jobId: string;
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
  timeoutId: ReturnType<typeof setTimeout>;
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
  private readonly jobs = new Map<string, ShellJob>();
  private readonly terminalJobIds: string[] = [];
  private readonly createJobId: () => string;
  private readonly killTree: ShellJobRegistryOptions["killTree"];

  constructor(options: ShellJobRegistryOptions) {
    this.createJobId = options.createJobId ?? randomUUID;
    this.killTree = options.killTree;
  }

  start(input: ShellJobStartInput): ShellJobSnapshot {
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const job: ShellJob = {
      child: input.child,
      captureMode: input.captureMode ?? "tail",
      contextScopeId: input.contextScopeId,
      jobId: this.createJobId(),
      metadata: input.metadata ?? {},
      output: "",
      stderr: "",
      stdout: "",
      resolveTerminal,
      sessionId: input.sessionId,
      status: "running",
      terminal,
      terminationStarted: false,
      timeoutId: setTimeout(() => {
        void this.terminate(job, "timed_out");
      }, input.timeoutMs),
      truncated: false,
    };
    this.jobs.set(job.jobId, job);
    this.pruneTerminalJobs();

    input.child.stdout?.on("data", (chunk: unknown) => {
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
    input.child.stderr?.on("data", (chunk: unknown) => {
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
    input.child.once("error", (error: Error) => {
      job.error = error.message;
    });
    input.child.once("exit", (exitCode, signal) => {
      if (isTerminal(job.status)) {
        return;
      }
      job.exitCode = exitCode;
      job.signal = signal;
    });
    input.child.once("close", (exitCode, signal) => {
      this.finishFromChild(
        job,
        exitCode ?? job.exitCode ?? null,
        signal ?? job.signal ?? null,
      );
    });

    return this.snapshot(job);
  }

  get(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): ShellJobSnapshot {
    return this.snapshot(this.getOwnedJob(jobId, sessionId, contextScopeId));
  }

  async waitForTerminal(
    jobId: string,
    sessionId: string,
    contextScopeId?: string,
  ): Promise<ShellJobSnapshot> {
    const job = this.getOwnedJob(jobId, sessionId, contextScopeId);
    if (!isTerminal(job.status)) {
      await job.terminal;
    }
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
    const job = this.getOwnedJob(jobId, sessionId, contextScopeId);
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
  ): Promise<ShellJobSnapshot> {
    const job = this.getOwnedJob(jobId, sessionId, contextScopeId);
    if (!isTerminal(job.status)) {
      await this.terminate(job, "cancelled");
    }
    return this.snapshot(job);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const ownedJobs = [...this.jobs.values()].filter(
      (job) => job.sessionId === sessionId,
    );
    await this.disposeJobs(ownedJobs);
  }

  async disposeScope(sessionId: string, contextScopeId: string): Promise<void> {
    const ownedJobs = [...this.jobs.values()].filter(
      (job) =>
        job.sessionId === sessionId && job.contextScopeId === contextScopeId,
    );
    await this.disposeJobs(ownedJobs);
  }

  private async disposeJobs(ownedJobs: readonly ShellJob[]): Promise<void> {
    await Promise.all(
      ownedJobs
        .filter((job) => !isTerminal(job.status))
        .map((job) => this.terminate(job, "cancelled")),
    );

    const ownedJobIds = new Set(ownedJobs.map((job) => job.jobId));
    for (const jobId of ownedJobIds) {
      this.jobs.delete(jobId);
    }
    for (let index = this.terminalJobIds.length - 1; index >= 0; index -= 1) {
      if (ownedJobIds.has(this.terminalJobIds[index] ?? "")) {
        this.terminalJobIds.splice(index, 1);
      }
    }
  }

  async dispose(): Promise<void> {
    const active = [...this.jobs.values()].filter(
      (job) => !isTerminal(job.status),
    );
    await Promise.all(active.map((job) => this.terminate(job, "cancelled")));
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
    const metadata = {
      ...job.metadata,
      jobId: job.jobId,
      status: job.status,
      truncated: rendered.truncated,
      ...(job.error ? { error: job.error } : {}),
      ...(isTerminal(job.status)
        ? { exitCode: job.exitCode ?? null, signal: job.signal ?? null }
        : {}),
    };
    return {
      jobId: job.jobId,
      metadata,
      output: rendered.output,
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
    clearTimeout(job.timeoutId);
    job.status = status;
    job.exitCode = exitCode;
    job.signal = signal;
    job.resolveTerminal();
    this.terminalJobIds.push(job.jobId);
    this.pruneTerminalJobs();
  }

  private pruneTerminalJobs(): void {
    while (this.jobs.size > MAX_RETAINED_SHELL_JOBS) {
      const oldestTerminalId = this.terminalJobIds.shift();
      if (!oldestTerminalId) {
        return;
      }
      this.jobs.delete(oldestTerminalId);
    }
  }

  private async waitForTerminalGrace(job: ShellJob): Promise<void> {
    if (isTerminal(job.status)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHELL_JOB_TERMINATION_GRACE_MS);
      void job.terminal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async terminate(
    job: ShellJob,
    reason: TerminationReason,
  ): Promise<void> {
    if (isTerminal(job.status)) {
      return;
    }
    if (job.terminationStarted) {
      return job.terminal;
    }
    job.terminationStarted = true;
    job.terminationReason = reason;
    try {
      await this.killTree(job.child);
    } catch {
      // The child exit still determines the terminal metadata.
    }
    await this.waitForTerminalGrace(job);
    if (!isTerminal(job.status)) {
      this.finish(job, reason, job.exitCode ?? null, job.signal ?? null);
    }
  }
}

function snapshotResult(snapshot: ShellJobSnapshot): ToolExecutionResult {
  return { metadata: snapshot.metadata, output: snapshot.output };
}

export function createTaskOutputTool(registry: ShellJobRegistry): Tool {
  return {
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
      );
    },
  };
}

export function createTaskKillTool(registry: ShellJobRegistry): Tool {
  return {
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
  };
}
