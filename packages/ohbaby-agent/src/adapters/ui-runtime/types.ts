import type { UiEvent } from "ohbaby-sdk";
import type {
  CommandMcpServerSummary,
  CommandToolSummary,
} from "../../commands/index.js";
import type { CompactResult, ContextUsage } from "../../core/context/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import type {
  AgentManager,
  AgentSessionStartResult,
  StartSessionParams,
} from "../../agents/index.js";
import type { GoalService } from "../../goals/index.js";
import type { TodoService } from "../../tools/todo.js";
import type { RunLedger } from "../../runtime/run-ledger/index.js";
import type { RunManager } from "../../runtime/run-manager/index.js";
import type { StreamBridge } from "../../runtime/stream-bridge/index.js";

export type PublishUiEvent = (event: UiEvent) => void;

export interface UiRuntimeComposition {
  readonly agentManager: AgentManager;
  readonly goals: GoalService;
  readonly todos: TodoService;
  readonly runLedger: RunLedger;
  readonly runManager: RunManager;
  readonly streamBridge: StreamBridge;
  readonly toolScheduler: ToolSchedulerInstance;
  reserveRunId(runId?: string): string;
  startSession(input: StartSessionParams): Promise<AgentSessionStartResult>;
  setSessionWorkdir(sessionId: string, workdir: string): Promise<void>;
  ensureSessionRecord(input: {
    readonly agentName: string;
    readonly id: string;
    readonly projectRoot: string;
    readonly title: string;
  }): Promise<void>;
  compactSession(input: {
    readonly force?: boolean;
    readonly isSubagent?: boolean;
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<CompactResult>;
  getContextUsage(input: {
    readonly projectRoot: string;
    readonly sessionId: string;
  }): Promise<ContextUsage>;
  listMcpServerSummaries(): Promise<readonly CommandMcpServerSummary[]>;
  listToolSummaries(input?: {
    readonly agentName?: string;
  }): Promise<readonly CommandToolSummary[]>;
  interruptRunTree(runId: string, reason?: string): Promise<void>;
  interruptSubagentsByParent(
    parentSessionId: string,
    reason?: string,
  ): Promise<void>;
  dispose(): Promise<void>;
}
