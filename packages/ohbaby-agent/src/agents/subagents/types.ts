import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import type { SubagentRole } from "../roles.js";

export type SubagentInstanceStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "interrupted"
  | "cancelled";

export interface QueuedSubagentInput {
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly workdir?: string;
}

export interface SubagentInstanceRecord {
  readonly subagentId: string;
  readonly sessionId: string;
  readonly contextScopeId: string;
  readonly parentSessionId: string;
  readonly role: SubagentRole;
  readonly name?: string;
  readonly description?: string;
  readonly initialPrompt: string;
  readonly status: SubagentInstanceStatus;
  readonly output?: string;
  readonly error?: string;
  readonly pendingQueue: readonly QueuedSubagentInput[];
  readonly currentInput?: QueuedSubagentInput;
  readonly currentRunId?: string;
  readonly lastRunId?: string;
  readonly timeoutMs?: number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly interruptedAt?: number;
  readonly closedAt?: number;
}

export interface SubagentLookupInput {
  readonly parentSessionId: string;
  readonly subagentId: string;
}

export type SubagentRunMode = "foreground" | "background";

export interface SubagentRunInput {
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly mode: SubagentRunMode;
  readonly role?: SubagentRole;
  readonly subagentId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly interrupt?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
}

export interface SubagentRunResult {
  readonly item: SubagentInstanceRecord;
  readonly output?: string;
  readonly success?: boolean;
}

export interface SubagentStatusInput {
  readonly parentSessionId: string;
  readonly subagentId?: string;
}

export interface SubagentStatusResult {
  readonly items: readonly SubagentInstanceRecord[];
}

export interface SubagentCloseResult {
  readonly item: SubagentInstanceRecord;
  readonly previousStatus: SubagentInstanceStatus;
}

type RequiredMutableSubagentFields = Pick<
  SubagentInstanceRecord,
  "status" | "pendingQueue" | "updatedAt"
>;

type ClearableMutableSubagentFields = Pick<
  SubagentInstanceRecord,
  | "output"
  | "error"
  | "currentInput"
  | "currentRunId"
  | "lastRunId"
  | "ownerId"
  | "ownerPid"
  | "startedAt"
  | "completedAt"
  | "interruptedAt"
  | "closedAt"
>;

export type SubagentInstanceUpdate = Partial<RequiredMutableSubagentFields> & {
  readonly [K in keyof ClearableMutableSubagentFields]?:
    | ClearableMutableSubagentFields[K]
    | undefined;
};

export function assertSubagentInstanceUpdate(
  update: SubagentInstanceUpdate,
): void {
  for (const field of ["status", "pendingQueue", "updatedAt"] as const) {
    if (field in update && update[field] === undefined) {
      throw new Error(`Subagent update ${field} must not be undefined`);
    }
  }
}

export interface MarkSubagentsInterruptedInput {
  readonly parentSessionId?: string;
  readonly interruptedAt?: number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly recoverUnknownOwner?: boolean;
}

export interface SubagentInstanceStore {
  /**
   * Append one recoverable input without replacing the current durable queue.
   * Returns null when the instance has reached its terminal close state.
   */
  appendPendingQueue(
    subagentId: string,
    input: QueuedSubagentInput,
    updatedAt: number,
  ): Promise<SubagentInstanceRecord | null>;
  create(record: SubagentInstanceRecord): Promise<void>;
  claim(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord | null>;
  finishRun(
    subagentId: string,
    currentRunId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord>;
  get(input: SubagentLookupInput): Promise<SubagentInstanceRecord | null>;
  update(
    subagentId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord>;
  listByParent(
    parentSessionId: string,
  ): Promise<readonly SubagentInstanceRecord[]>;
  markInterrupted(
    input?: MarkSubagentsInterruptedInput,
  ): Promise<readonly SubagentInstanceRecord[]>;
}
