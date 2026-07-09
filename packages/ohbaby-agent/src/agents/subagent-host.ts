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
  closed: boolean;
  queue: QueuedSubagentInput[];
  running: boolean;
}

export interface SessionSubagentHostOptions {
  readonly agentManager: Pick<AgentManager, "getRuntimeAgent">;
  readonly instanceFactory: AgentInstanceFactory;
  readonly modelId: string;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly store: SubagentInstanceStore;
  readonly createSubagentId?: () => string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly now?: () => number;
}

function defaultSubagentId(): string {
  return `subagent_${Date.now().toString(36)}_${Math.random()
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
  return Math.trunc(timeoutMs);
}

function timeoutMessage(timeoutMs: number): string {
  return `Subagent timed out after ${String(timeoutMs)}ms`;
}

export class SessionSubagentHost {
  private readonly active = new Map<string, ActiveSubagentState>();
  private readonly parentSessionLocks = new Map<string, Promise<void>>();
  private readonly createSubagentId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: SessionSubagentHostOptions) {
    this.createSubagentId = options.createSubagentId ?? defaultSubagentId;
    this.now = options.now ?? Date.now;
  }

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const record =
      input.subagentId === undefined
        ? await this.withParentSessionLock(input.parentSessionId, () =>
            this.createRecord(input),
          )
        : await this.getExisting(input);
    const active = this.active.get(record.subagentId);
    if (active?.running && input.mode === "foreground") {
      throw new Error(
        `Subagent is already running: ${record.subagentId}. Use background mode to queue input, or interrupt the running turn.`,
      );
    }
    if (input.mode === "background") {
      this.enqueueOrSchedule(
        record,
        input.prompt,
        input.environment,
        input.interrupt === true,
        input.timeoutMs,
      );
      return {
        item: await this.mustGet(record.parentSessionId, record.subagentId),
      };
    }

    const item = await this.runTurn(
      record,
      input.prompt,
      input.environment,
      input.signal,
      input.timeoutMs,
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
    const item = await this.mustGet(input.parentSessionId, input.subagentId);
    const previousStatus = item.status;
    const active = this.active.get(input.subagentId);
    if (active) {
      active.closed = true;
      active.queue.length = 0;
      active.abortController?.abort("subagent closed");
    }
    const updated = await this.options.store.update(input.subagentId, {
      closedAt: this.now(),
      pendingQueue: [],
      status: "cancelled",
      updatedAt: this.now(),
    });
    return { item: updated, previousStatus };
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
        : await this.getSession(existing[0].sessionId);
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
      pendingQueue: [],
      role: input.role,
      sessionId: session.id,
      status: "pending",
      subagentId,
      timeoutMs: input.timeoutMs,
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

  private async getSession(sessionId: string): Promise<Session> {
    const session = await this.options.sessionManager.get(sessionId);
    if (!session) {
      throw new Error(`Subagent session not found: ${sessionId}`);
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

  private enqueueOrSchedule(
    record: SubagentInstanceRecord,
    prompt: string,
    environment?: ToolExecutionEnvironment,
    interrupt = false,
    timeoutMs?: number,
  ): void {
    const active = this.active.get(record.subagentId);
    if (active?.running) {
      if (interrupt) {
        active.queue.length = 0;
        active.abortController?.abort("subagent interrupted");
      }
      active.queue.push({ environment, prompt, timeoutMs });
      void this.options.store.update(record.subagentId, {
        pendingQueue: active.queue,
        updatedAt: this.now(),
      });
      return;
    }
    void Promise.resolve().then(() =>
      this.runTurn(record, prompt, environment, undefined, timeoutMs).catch(
        () => undefined,
      ),
    );
  }

  private async runTurn(
    record: SubagentInstanceRecord,
    prompt: string,
    environment?: ToolExecutionEnvironment,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SubagentInstanceRecord> {
    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs ?? record.timeoutMs);
    const deadlineReason =
      effectiveTimeoutMs === undefined
        ? undefined
        : timeoutMessage(effectiveTimeoutMs);
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      record.role,
      { isSubagent: true },
    );
    const abortController = new AbortController();
    const abort = (): void => {
      abortController.abort(signal?.reason);
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    const active: ActiveSubagentState = {
      abortController,
      closed: false,
      queue: [],
      running: true,
    };
    this.active.set(record.subagentId, active);
    await this.options.store.update(record.subagentId, {
      currentRunId: undefined,
      error: undefined,
      output: undefined,
      pendingQueue: [],
      startedAt: this.now(),
      status: "running",
      timeoutMs: effectiveTimeoutMs,
      updatedAt: this.now(),
    });
    const deadline =
      effectiveTimeoutMs === undefined || deadlineReason === undefined
        ? undefined
        : createDeadlineController({
            parent: abortController.signal,
            reason: deadlineReason,
            timeoutMs: effectiveTimeoutMs,
          });
    const turnSignal = deadline?.signal ?? abortController.signal;
    const timedOut = (): boolean =>
      deadline !== undefined &&
      deadlineReason !== undefined &&
      deadline.signal.aborted &&
      deadline.signal.reason === deadlineReason;
    const markTimedOut = (): Promise<SubagentInstanceRecord> =>
      this.options.store.update(record.subagentId, {
        completedAt: this.now(),
        error: deadlineReason,
        output: deadlineReason,
        status: "timed_out",
        updatedAt: this.now(),
      });

    try {
      const session = await this.getSession(record.sessionId);
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
      const result = await instance.turn({
        environment,
        prompt,
        signal: turnSignal,
        waitMode: "waitForCompletion",
      });
      if (active.closed) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      if (timedOut()) {
        return await markTimedOut();
      }
      const { output, success } = successfulOutput(result);
      return await this.options.store.update(record.subagentId, {
        completedAt: this.now(),
        error: success ? undefined : output,
        output,
        status: success ? "completed" : "failed",
        updatedAt: this.now(),
      });
    } catch (error) {
      if (active.closed) {
        return await this.mustGet(record.parentSessionId, record.subagentId);
      }
      if (timedOut()) {
        return await markTimedOut();
      }
      return await this.options.store.update(record.subagentId, {
        completedAt: this.now(),
        error: errorMessage(error),
        output: errorMessage(error),
        status: "failed",
        updatedAt: this.now(),
      });
    } finally {
      deadline?.dispose();
      signal?.removeEventListener("abort", abort);
      active.running = false;
      this.active.delete(record.subagentId);
      const next = active.queue.shift();
      if (!active.closed && next) {
        this.enqueueOrSchedule(
          record,
          next.prompt,
          next.environment,
          false,
          next.timeoutMs,
        );
      }
    }
  }
}
