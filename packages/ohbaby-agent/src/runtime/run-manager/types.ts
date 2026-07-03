import type {
  LifecycleEvent,
  LifecycleResult,
  LifecycleSessionParams,
} from "../../core/lifecycle/index.js";
import type { SandboxLease, SandboxManagerPort } from "../../sandbox/index.js";
import type {
  RunLedger,
  RunStatus,
  TriggerSource,
} from "../run-ledger/index.js";
import type { StreamBridge } from "../stream-bridge/index.js";

export type MultitaskStrategy = "reject" | "queue" | "interrupt-current";
export type DisconnectMode = "continue" | "pause";
export type TerminalRunStatus = Exclude<RunStatus, "pending" | "running">;

export interface RunDefaults {
  readonly permissionProfileId: string;
  readonly multitaskStrategy: MultitaskStrategy;
  readonly disconnectMode: DisconnectMode;
}

export interface RunDefaultsPolicy {
  readonly defaults: Readonly<Partial<Record<TriggerSource, RunDefaults>>>;
}

export interface CreateRunOptions {
  readonly runId?: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
  readonly explicit?: Partial<RunDefaults>;
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  readonly directory: string;
  readonly modelId: string;
  readonly tools?: LifecycleSessionParams["tools"];
}

export interface RunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
  readonly status: RunStatus;
  readonly permissionProfileId: string;
  readonly multitaskStrategy: MultitaskStrategy;
  readonly disconnectMode: DisconnectMode;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly terminalReason?: LifecycleResult["terminalReason"];
}

export interface RunCompletion {
  readonly status: TerminalRunStatus;
  readonly error?: string;
  readonly terminalReason?: LifecycleResult["terminalReason"];
  readonly usage?: LifecycleResult["usage"];
}

export type { SandboxLease };
export type SandboxManager = SandboxManagerPort;

export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
  readonly permissionProfileId: string;
  readonly sandboxLease: SandboxLease;
  readonly abortSignal: AbortSignal;
  readonly agent?: string;
  readonly isSubagent?: boolean;
  readonly parentMessageId?: string;
  readonly maxSteps?: number;
  readonly directory: string;
  readonly modelId: string;
  readonly tools?: LifecycleSessionParams["tools"];
}

export interface RunHookContext {
  readonly run: RunRecord;
  readonly runId: string;
  readonly sessionId: string;
  readonly triggerSource: TriggerSource;
  readonly permissionProfileId?: string;
  readonly sandboxLease?: SandboxLease;
  readonly status?: RunStatus;
  readonly result?: LifecycleResult;
  readonly error?: unknown;
}

export interface HookExecutor {
  execute(
    point: "pre-run" | "post-run",
    context: RunHookContext,
  ): Promise<void>;
}

export interface RunLifecycle {
  run(
    params: LifecycleSessionParams,
  ): AsyncGenerator<LifecycleEvent, LifecycleResult, void>;
}

export interface RunManagerDeps {
  readonly lifecycle: RunLifecycle;
  readonly runLedger: RunLedger;
  readonly streamBridge: StreamBridge;
  readonly hookExecutor?: HookExecutor;
  readonly sandboxManager: SandboxManager;
  readonly policy: RunDefaultsPolicy;
  readonly now?: () => number;
  readonly createRunId?: () => string;
}

export interface RunWorkerResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly result?: LifecycleResult;
  readonly error?: string;
  readonly terminalReason?: LifecycleResult["terminalReason"];
}

export interface RunWorkerDeps {
  readonly lifecycle: RunLifecycle;
  readonly streamBridge: StreamBridge;
  readonly hookExecutor?: HookExecutor;
}

export interface RunWorkerStartOptions {
  readonly run: RunRecord;
  readonly onRunning: () => Promise<void>;
}

export interface ManagedRunRecord extends RunRecord {
  readonly abortController: AbortController;
  readonly options: CreateRunOptions;
  completion?: Promise<RunCompletion>;
  sandboxLease?: SandboxLease;
  cancelReason?: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  terminalReason?: LifecycleResult["terminalReason"];
}

export type { RunStatus, TriggerSource };
