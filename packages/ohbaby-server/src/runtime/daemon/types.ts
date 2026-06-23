export type DaemonStatus = "running" | "stopping" | "stopped" | "crashed";

export interface DaemonState {
  readonly status: DaemonStatus;
  readonly pid?: number;
  readonly pidToken?: string;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly error?: string;
  readonly host?: string;
  readonly port?: number;
  readonly packageVersion?: string;
  readonly authToken?: string;
  readonly idleSince?: number;
  readonly scopeRoot?: string;
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
  readonly connection?: {
    readonly host: string;
    readonly port: number;
    readonly authToken?: string;
    readonly packageVersion?: string;
    readonly scopeRoot?: string;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonSignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface DaemonLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}
