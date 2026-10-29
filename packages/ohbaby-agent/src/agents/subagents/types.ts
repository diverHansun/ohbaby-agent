import type { ToolExecutionEnvironment } from "../../core/tool-scheduler/index.js";
import type { SubagentExecutionRecord } from "./execution-store.js";
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
  /** Legacy audit only: closed entries are never admitted again. */
  readonly closedAt?: number;
  readonly closeReason?: string;
  /** Absent only on legacy instance projections; never infer task ownership. */
  readonly executionId?: string;
  readonly rootRunId?: string;
  readonly requesterRunId?: string;
  readonly requesterScopeId?: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly workdir?: string;
}

export function closeLegacySubagentInputs(
  queue: readonly QueuedSubagentInput[],
  reason: string,
  at: number,
  matches: (entry: QueuedSubagentInput) => boolean = () => true,
): readonly QueuedSubagentInput[] {
  if (!queue.some((entry) => entry.closedAt === undefined && matches(entry)))
    return queue;
  return queue.map((entry) => {
    if (entry.closedAt !== undefined || !matches(entry)) return entry;
    return { ...entry, closedAt: at, closeReason: reason };
  });
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
  readonly requesterRunId: string;
  readonly requesterMessageId: string;
  readonly requestId: string;
  /** Internal invoking scope, supplied by tool execution context. */
  readonly parentContextScopeId?: string;
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
  /** This input is retained in the queue and has not run. */
  readonly paused?: true;
  readonly execution: SubagentExecutionRecord;
  readonly item?: SubagentInstanceRecord;
  readonly output?: string;
  readonly success?: boolean;
}

export type SubagentSpawnInput = Omit<
  SubagentRunInput,
  "subagentId" | "interrupt"
>;
export type SubagentSendInput = SubagentSpawnInput & {
  readonly subagentId: string;
};
export type SubagentStartResult =
  | {
      readonly started: false;
      readonly reason: string;
      readonly accepted?: false;
      readonly execution?: undefined;
    }
  | (SubagentRunResult & {
      readonly started: boolean;
      readonly accepted?: true;
      readonly inputId?: string;
    });

export interface SubagentUnprocessedMessage {
  readonly inputId: string;
  readonly text: string;
  readonly reason: string;
}
export interface SubagentCleanupResult {
  readonly confirmed: boolean;
  /** Resolves only once a previously unconfirmed cleanup has physical exit evidence. */
  readonly settled?: Promise<void>;
}
export interface SubagentStopInput extends SubagentLookupInput {
  readonly expectedExecutionId?: string;
}
export interface SubagentStopResult {
  readonly subagentId: string;
  readonly stopped: boolean;
  readonly execution?: SubagentExecutionRecord;
  readonly reason?: string;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly unprocessedMessages: readonly SubagentUnprocessedMessage[];
}

export interface SubagentStatusInput {
  readonly parentSessionId: string;
  readonly subagentId?: string;
  readonly executionId?: string;
  readonly parentContextScopeId?: string;
}

export interface SubagentStatusResult {
  readonly facts?: readonly import("./execution-facts.js").ExecutionFactView[];
  readonly items: readonly SubagentInstanceRecord[];
  readonly executions: readonly SubagentExecutionRecord[];
  readonly runtime?: readonly {
    readonly subagentId: string;
    readonly executionId?: string;
    readonly settling: boolean;
    readonly unprocessedMessages: readonly SubagentUnprocessedMessage[];
  }[];
}

export interface SubagentCloseResult {
  readonly subagentId: string;
  readonly reason?: string;
  readonly item?: SubagentInstanceRecord;
  readonly previousStatus: SubagentInstanceStatus;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly unprocessedMessages: readonly SubagentUnprocessedMessage[];
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

export interface RecoverSubagentExecutionInputsInput {
  readonly subagentId: string;
  readonly executionIds: readonly string[];
  readonly rootRunIds: readonly string[];
  /** Undefined is an expected missing value, not a wildcard. */
  readonly expectedOwnerId?: string;
  readonly expectedOwnerPid?: number;
  readonly expectedCurrentRunId?: string;
  readonly at: number;
}

/** Build the repair from the latest record inside the store's write boundary. */
export function recoveryExecutionInputsUpdate(
  record: SubagentInstanceRecord,
  input: RecoverSubagentExecutionInputsInput,
): SubagentInstanceUpdate | undefined {
  const executions = new Set(input.executionIds);
  const roots = new Set(input.rootRunIds);
  const belongs = (entry: QueuedSubagentInput | undefined): boolean =>
    entry !== undefined &&
    ((entry.executionId !== undefined && executions.has(entry.executionId)) ||
      (entry.rootRunId !== undefined && roots.has(entry.rootRunId)));
  const interruptCurrent =
    (record.status === "pending" || record.status === "running") &&
    belongs(record.currentInput);
  if (
    interruptCurrent &&
    (record.ownerId !== input.expectedOwnerId ||
      record.ownerPid !== input.expectedOwnerPid ||
      record.currentRunId !== input.expectedCurrentRunId)
  ) {
    throw new Error(
      `Subagent recovery ownership conflict: ${input.subagentId}`,
    );
  }
  const pendingQueue = closeLegacySubagentInputs(
    record.pendingQueue,
    "runtime interrupted",
    input.at,
    belongs,
  );
  if (!interruptCurrent && pendingQueue === record.pendingQueue)
    return undefined;
  return {
    pendingQueue,
    updatedAt: Math.max(record.updatedAt, input.at),
    ...(interruptCurrent
      ? {
          status: "interrupted",
          currentInput: undefined,
          currentRunId: undefined,
          lastRunId: record.currentRunId ?? record.lastRunId,
          interruptedAt: input.at,
          completedAt: input.at,
        }
      : {}),
  };
}

export interface SubagentInstanceStore {
  subscribe(listener: (record: SubagentInstanceRecord) => void): () => void;
  recoverExecutionInputs(
    input: RecoverSubagentExecutionInputsInput,
  ): Promise<SubagentInstanceRecord>;
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
