import type {
  CoreAPI,
  SDKAPI,
  UiEventHandler,
  UiUnsubscribe,
} from "ohbaby-sdk";
import type { createStdoutRenderer } from "../stdout-renderer.js";

export type CliDaemonStatus = "running" | "stopping" | "stopped" | "crashed";

export interface CliDaemonState {
  readonly status: CliDaemonStatus;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface CliStartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
}

export interface CliRunningDaemonServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface CliGlobalOptions {
  readonly continue?: boolean;
  readonly daemon?: boolean;
  readonly inProcess?: boolean;
  readonly mode?: "plan" | "auto";
  readonly noDaemon?: boolean;
  readonly permission?: "default" | "full-access";
  readonly remoteHost?: string;
  readonly remotePort?: number;
  readonly resume?: string;
}

export interface CliCoreHost {
  readonly core: CoreAPI;
  readonly callbacks: SDKAPI;
  readonly dispose: () => Promise<void>;
}

export type CliCoreHostResult = CliCoreHost | Promise<CliCoreHost>;

export interface CliWritable {
  write(chunk: string): unknown;
}

export interface TerminalUiLifecycle {
  readonly waitUntilExit?: () => Promise<void>;
}

export interface CliCommandRuntime {
  readonly createCoreHost: (options: CliGlobalOptions) => CliCoreHostResult;
  readonly createStdoutRenderer: typeof createStdoutRenderer;
  readonly failUsage: (message: string) => never;
  readonly isStdinTTY: () => boolean;
  readonly readDaemonStatus: () => Promise<CliDaemonState | undefined>;
  readonly readStdin: () => Promise<string>;
  readonly renderTerminalUi: (options: {
    readonly client: CoreAPI;
    readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  }) => TerminalUiLifecycle;
  readonly setExitCode: (code: number) => void;
  readonly startDaemonServer: (
    options: CliStartDaemonServerOptions,
  ) => Promise<CliRunningDaemonServer>;
  readonly stderr: CliWritable;
  readonly stdout: CliWritable;
  readonly stopDaemonFromState: () => Promise<"stopped" | "not-running">;
}
