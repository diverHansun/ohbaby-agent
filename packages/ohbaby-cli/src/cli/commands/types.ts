import type {
  CoreAPI,
  SDKAPI,
  UiEventHandler,
  UiUnsubscribe,
} from "ohbaby-sdk";
import type { createStdoutRenderer } from "../stdout-renderer.js";

export interface CliGlobalOptions {
  readonly continue?: boolean;
  readonly mode?: "plan" | "auto";
  readonly permission?: "default" | "full-access";
  readonly resume?: string;
}

export interface CliCoreHost {
  readonly core: CoreAPI;
  readonly callbacks: SDKAPI;
  readonly dispose: () => Promise<void>;
}

export interface CliWritable {
  write(chunk: string): unknown;
}

export interface TerminalUiLifecycle {
  readonly waitUntilExit?: () => Promise<void>;
}

export interface CliCommandRuntime {
  readonly createCoreHost: (options: CliGlobalOptions) => CliCoreHost;
  readonly createStdoutRenderer: typeof createStdoutRenderer;
  readonly failUsage: (message: string) => never;
  readonly isStdinTTY: () => boolean;
  readonly readStdin: () => Promise<string>;
  readonly renderTerminalUi: (options: {
    readonly client: CoreAPI;
    readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  }) => TerminalUiLifecycle;
  readonly setExitCode: (code: number) => void;
  readonly stderr: CliWritable;
}
