import type { BusInstance } from "../../bus/index.js";
import type { RunLedger } from "../run-ledger/index.js";
import type {
  HookExecutor,
  RunDefaultsPolicy,
  RunLifecycle,
  SandboxManager,
} from "../run-manager/index.js";
import type { StreamBridge } from "../stream-bridge/index.js";

export type DaemonStatus = "running" | "stopping" | "stopped" | "crashed";

export interface DaemonState {
  readonly status: DaemonStatus;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface DaemonStateFile {
  read?(): Promise<DaemonState | undefined>;
  write(state: DaemonState): Promise<void>;
}

export interface DaemonPidRecord {
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
}

export interface DaemonPidLock {
  readonly record?: DaemonPidRecord;
  release(): Promise<void>;
}

export interface DaemonPidFile {
  read?(): Promise<DaemonPidRecord | undefined>;
  acquire(): Promise<DaemonPidLock>;
}

export interface DaemonRuntimeHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonRunManager {
  init(): Promise<{ readonly updatedCount: number }>;
  cancelAll(reason?: string): Promise<void>;
}

export interface DaemonInteractionBroker {
  abortAll(reason: string): Promise<void> | void;
}

export interface DaemonDatabase {
  close(): Promise<void> | void;
}

export interface DaemonEventAdapter {
  dispose(): Promise<void> | void;
}

export interface DaemonEventAdapterDeps {
  readonly bus: BusInstance;
  readonly streamBridge: StreamBridge;
}

export type DaemonEventAdapterStarter = (
  deps: DaemonEventAdapterDeps,
) => DaemonEventAdapter;

export interface RuntimeBootstrapOptions {
  readonly bus?: BusInstance;
  readonly lifecycle?: RunLifecycle;
  readonly runLedger?: RunLedger;
  readonly streamBridge?: StreamBridge;
  readonly runManager?: DaemonRunManager;
  readonly hookExecutor?: HookExecutor;
  readonly sandboxManager?: SandboxManager;
  readonly policy?: RunDefaultsPolicy;
  readonly interactionBroker?: DaemonInteractionBroker;
  readonly database?: DaemonDatabase;
  readonly startAppEventAdapter?: DaemonEventAdapterStarter;
  readonly now?: () => number;
  readonly createRunId?: () => string;
}

export interface BootstrappedRuntime extends DaemonRuntimeHandle {
  readonly bus: BusInstance;
  readonly runLedger: RunLedger;
  readonly streamBridge: StreamBridge;
  readonly runManager: DaemonRunManager;
  readonly interactionBroker: DaemonInteractionBroker;
  readonly database?: DaemonDatabase;
}

export interface DaemonSignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface DaemonLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
