import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import type { SubagentRole } from "../roles.js";

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "timed_out";

export interface AgentTaskRecord {
  readonly taskId: string;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly role: SubagentRole;
  readonly name?: string;
  readonly description?: string;
  readonly prompt: string;
  readonly status: AgentTaskStatus;
  readonly output?: string;
  readonly error?: string;
  readonly pendingInputCount: number;
  readonly timeoutMs?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface AgentTaskOpenInput {
  readonly role: SubagentRole;
  readonly name?: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly description?: string;
  readonly environment?: ToolExecutionEnvironment;
  readonly signal?: AbortSignal;
}

export interface AgentTaskSendInput {
  readonly taskId: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly interrupt?: boolean;
  readonly environment?: ToolExecutionEnvironment;
}

export interface AgentTaskLookupInput {
  readonly parentSessionId: string;
  readonly taskId: string;
}

export interface AgentTaskCloseResult {
  readonly task: AgentTaskRecord;
  readonly previousStatus: AgentTaskStatus;
}

export interface AgentTaskController {
  open(input: AgentTaskOpenInput): Promise<AgentTaskRecord>;
  sendInput(input: AgentTaskSendInput): Promise<AgentTaskRecord>;
  get(input: AgentTaskLookupInput): Promise<AgentTaskRecord | null>;
  close(input: AgentTaskLookupInput): Promise<AgentTaskCloseResult>;
}

type MutableAgentTaskFields = Omit<AgentTaskRecord, "taskId" | "createdAt">;

export type AgentTaskStoreUpdate = {
  readonly [K in keyof MutableAgentTaskFields]?:
    | MutableAgentTaskFields[K]
    | undefined;
};

export interface AgentTaskStore {
  create(record: AgentTaskRecord): Promise<AgentTaskRecord>;
  get(taskId: string): Promise<AgentTaskRecord | null>;
  update(
    taskId: string,
    update: AgentTaskStoreUpdate,
  ): Promise<AgentTaskRecord>;
  list(): Promise<readonly AgentTaskRecord[]>;
}
