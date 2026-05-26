import {
  runAgent,
  type AgentRunResult,
  type AgentPromptMessageBuilder,
  type AgentRunCoordinator,
  type AgentSandboxEnvironmentManager,
} from "../../core/agents/index.js";
import type { MessageManager } from "../../core/message/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import type { Session, SessionManager } from "../../services/session/index.js";
import { AgentManager } from "../manager.js";
import type { RuntimeAgent } from "../types.js";
import { InMemoryAgentTaskStore } from "./in-memory-store.js";
import type {
  AgentTaskCloseResult,
  AgentTaskController,
  AgentTaskLookupInput,
  AgentTaskOpenInput,
  AgentTaskRecord,
  AgentTaskSendInput,
  AgentTaskStatus,
  AgentTaskStore,
} from "./types.js";

const DEFAULT_MAX_TASKS = 12;
const DEFAULT_MAX_TASKS_PER_PARENT = 3;

interface QueuedInput {
  readonly prompt: string;
  readonly environment?: AgentTaskOpenInput["environment"];
}

interface ActiveTaskState {
  abortController?: AbortController;
  closed: boolean;
  environment?: AgentTaskOpenInput["environment"];
  queue: QueuedInput[];
  running: boolean;
  runtimeAgent: RuntimeAgent;
  session: Session;
}

export interface AgentTaskManagerOptions {
  readonly agentManager: AgentManager;
  readonly buildPromptMessages: AgentPromptMessageBuilder;
  readonly messageManager: MessageManager;
  readonly runCoordinator: AgentRunCoordinator;
  readonly sandboxManager?: AgentSandboxEnvironmentManager;
  readonly sessionManager: Pick<SessionManager, "create" | "get">;
  readonly toolScheduler: Pick<ToolSchedulerInstance, "getAvailableTools">;
  readonly store?: AgentTaskStore;
  readonly createTaskId?: () => string;
  readonly maxTasks?: number;
  readonly maxTasksPerParent?: number;
  readonly now?: () => number;
}

function defaultTaskId(): string {
  return `agent_task_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new Error("Agent task open aborted");
}

function statusAfterRun(result: AgentRunResult): AgentTaskStatus {
  return result.success ? "completed" : "failed";
}

export class AgentTaskManager implements AgentTaskController {
  private readonly active = new Map<string, ActiveTaskState>();
  private readonly createTaskId: () => string;
  private readonly maxTasks: number;
  private readonly maxTasksPerParent: number;
  private readonly now: () => number;
  private readonly store: AgentTaskStore;

  constructor(private readonly options: AgentTaskManagerOptions) {
    this.createTaskId = options.createTaskId ?? defaultTaskId;
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    this.maxTasksPerParent =
      options.maxTasksPerParent ?? DEFAULT_MAX_TASKS_PER_PARENT;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryAgentTaskStore();
  }

  async open(input: AgentTaskOpenInput): Promise<AgentTaskRecord> {
    throwIfAborted(input.signal);
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      input.agentName,
      { isSubagent: true },
    );
    throwIfAborted(input.signal);
    if (runtimeAgent.config.mode === "primary") {
      throw new Error(`Agent ${input.agentName} cannot be used as a subagent`);
    }
    const parent = await this.options.sessionManager.get(input.parentSessionId);
    throwIfAborted(input.signal);
    if (!parent) {
      throw new Error(`Parent session not found: ${input.parentSessionId}`);
    }
    await this.assertTaskCapacity(input.parentSessionId);
    const session = await this.options.sessionManager.create(
      parent.projectRoot,
      {
        agentName: input.agentName,
        parentId: parent.id,
        title: input.description,
      },
    );
    throwIfAborted(input.signal);
    const taskId = this.createTaskId();
    const now = this.now();
    const record = await this.store.create({
      agentName: input.agentName,
      createdAt: now,
      description: input.description,
      parentSessionId: input.parentSessionId,
      pendingInputCount: 0,
      prompt: input.prompt,
      sessionId: session.id,
      status: "pending",
      taskId,
      updatedAt: now,
    });
    const state: ActiveTaskState = {
      closed: false,
      environment: input.environment,
      queue: [],
      running: false,
      runtimeAgent,
      session,
    };
    this.active.set(taskId, state);
    if (input.signal?.aborted) {
      state.closed = true;
      this.active.delete(taskId);
      await this.store.update(taskId, {
        completedAt: this.now(),
        status: "cancelled",
        updatedAt: this.now(),
      });
      throwIfAborted(input.signal);
    }
    this.scheduleTurn(taskId, input.prompt, input.environment);
    return record;
  }

  async sendInput(input: AgentTaskSendInput): Promise<AgentTaskRecord> {
    const task = await this.mustGetOwned(input);
    if (task.status === "cancelled") {
      throw new Error(`Agent task is closed: ${input.taskId}`);
    }
    const state = await this.ensureState(task);
    if (input.interrupt && state.abortController) {
      state.queue.unshift({
        environment: input.environment,
        prompt: input.prompt,
      });
      await this.updatePendingCount(input.taskId, state);
      state.abortController.abort("agent task interrupted");
      return this.mustGet(input.taskId);
    }
    if (state.running) {
      state.queue.push({
        environment: input.environment,
        prompt: input.prompt,
      });
      return this.updatePendingCount(input.taskId, state);
    }
    const pending = await this.store.update(input.taskId, {
      completedAt: undefined,
      error: undefined,
      output: undefined,
      status: "pending",
      updatedAt: this.now(),
    });
    this.scheduleTurn(input.taskId, input.prompt, input.environment);
    return pending;
  }

  async get(input: AgentTaskLookupInput): Promise<AgentTaskRecord | null> {
    const task = await this.store.get(input.taskId);
    if (!task || !this.belongsToParent(task, input.parentSessionId)) {
      return null;
    }
    return task;
  }

  async close(input: AgentTaskLookupInput): Promise<AgentTaskCloseResult> {
    const task = await this.mustGetOwned(input);
    const previousStatus = task.status;
    const state = this.active.get(input.taskId);
    if (state) {
      state.closed = true;
      state.queue.length = 0;
      state.abortController?.abort("agent task closed");
    }
    const next = await this.store.update(input.taskId, {
      completedAt: this.now(),
      pendingInputCount: 0,
      status: "cancelled",
      updatedAt: this.now(),
    });
    return { previousStatus, task: next };
  }

  private async ensureState(task: AgentTaskRecord): Promise<ActiveTaskState> {
    const existing = this.active.get(task.taskId);
    if (existing) {
      return existing;
    }
    const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
      task.agentName,
      { isSubagent: true },
    );
    const session = await this.options.sessionManager.get(task.sessionId);
    if (!session) {
      throw new Error(`Subagent session not found: ${task.sessionId}`);
    }
    const state: ActiveTaskState = {
      closed: false,
      queue: [],
      running: false,
      runtimeAgent,
      session,
    };
    this.active.set(task.taskId, state);
    return state;
  }

  private async mustGet(taskId: string): Promise<AgentTaskRecord> {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new Error(`Agent task not found: ${taskId}`);
    }
    return task;
  }

  private async mustGetOwned(
    input: AgentTaskLookupInput,
  ): Promise<AgentTaskRecord> {
    const task = await this.mustGet(input.taskId);
    if (!this.belongsToParent(task, input.parentSessionId)) {
      throw new Error(`Agent task not found: ${input.taskId}`);
    }
    return task;
  }

  private belongsToParent(
    task: AgentTaskRecord,
    parentSessionId: string,
  ): boolean {
    return task.parentSessionId === parentSessionId;
  }

  private async assertTaskCapacity(parentSessionId: string): Promise<void> {
    const retained = (await this.store.list()).filter(
      (task) => task.status !== "cancelled",
    );
    if (retained.length >= this.maxTasks) {
      throw new Error(
        `Too many retained agent tasks; close one before opening another.`,
      );
    }
    const retainedForParent = retained.filter(
      (task) => task.parentSessionId === parentSessionId,
    );
    if (retainedForParent.length >= this.maxTasksPerParent) {
      throw new Error(
        `Too many retained agent tasks for this session; close one before opening another.`,
      );
    }
  }

  private async updatePendingCount(
    taskId: string,
    state: ActiveTaskState,
  ): Promise<AgentTaskRecord> {
    return this.store.update(taskId, {
      pendingInputCount: state.queue.length,
      updatedAt: this.now(),
    });
  }

  private isClosed(taskId: string): boolean {
    return this.active.get(taskId)?.closed === true;
  }

  private scheduleTurn(
    taskId: string,
    prompt: string,
    environment?: AgentTaskOpenInput["environment"],
  ): void {
    void Promise.resolve().then(() =>
      this.runTurn(taskId, prompt, environment),
    );
  }

  private async runTurn(
    taskId: string,
    prompt: string,
    environment?: AgentTaskOpenInput["environment"],
  ): Promise<void> {
    const state = this.active.get(taskId);
    if (!state || state.closed || state.running) {
      return;
    }
    state.running = true;
    state.environment = environment;
    state.abortController = new AbortController();
    await this.store.update(taskId, {
      completedAt: undefined,
      error: undefined,
      output: undefined,
      pendingInputCount: state.queue.length,
      status: "running",
      updatedAt: this.now(),
    });

    try {
      const task = await this.mustGet(taskId);
      const result = await runAgent(
        {
          messageManager: this.options.messageManager,
          runCoordinator: this.options.runCoordinator,
          sandboxManager: this.options.sandboxManager,
          toolScheduler: this.options.toolScheduler,
        },
        {
          agentName: state.runtimeAgent.config.name,
          buildPromptMessages: this.options.buildPromptMessages,
          environment,
          initialUserPrompt: prompt,
          maxSteps: state.runtimeAgent.config.maxSteps,
          parentSessionId: task.parentSessionId,
          projectRoot: state.session.projectRoot,
          sessionId: state.session.id,
          signal: state.abortController.signal,
          waitMode: "waitForCompletion",
        },
      );
      const output = result.finalOutput ?? result.error ?? "";
      if (!this.isClosed(taskId)) {
        await this.store.update(taskId, {
          completedAt: this.now(),
          error: result.success ? undefined : output,
          output,
          status: statusAfterRun(result),
          updatedAt: this.now(),
        });
      }
    } catch (error) {
      if (!this.isClosed(taskId)) {
        await this.store.update(taskId, {
          completedAt: this.now(),
          error: errorMessage(error),
          output: errorMessage(error),
          status: "failed",
          updatedAt: this.now(),
        });
      }
    } finally {
      state.abortController = undefined;
      state.running = false;
      if (this.isClosed(taskId)) {
        this.active.delete(taskId);
      } else {
        const next = state.queue.shift();
        await this.updatePendingCount(taskId, state);
        if (next) {
          this.scheduleTurn(taskId, next.prompt, next.environment);
        }
      }
    }
  }
}
