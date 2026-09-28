import type {
  CoreAPI,
  SDKAPI,
  UiCommandRecorder,
  UiSnapshot,
} from "ohbaby-sdk";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "../adapters/ui-persistent.js";
import { McpManager } from "../mcp/index.js";
import { createUiCommandGateway } from "./ui-command-gateway.js";
import type { Logger } from "../observability/index.js";
import {
  beginDatabaseShutdown,
  DatabaseNotInitializedError,
} from "../services/database/index.js";
import {
  collectCleanup,
  createShutdownOptions,
  type ShutdownOptions,
} from "../runtime/shutdown.js";

export interface CoreApiFactoryOptions {
  readonly commandRecorder?: UiCommandRecorder | false;
  readonly continue?: boolean;
  readonly inProcess?: boolean;
  readonly mode?: "plan" | "auto";
  readonly permission?: "default" | "full-access";
  readonly resume?: string;
  readonly logger?: Logger;
  readonly diagnosticsFilePath?: string;
}

const NOOP_COMMAND_RECORDER: UiCommandRecorder = {
  record(): void {
    return;
  },
};

function commandRecorderFromOptions(
  options: CoreApiFactoryOptions,
): UiCommandRecorder {
  return options.commandRecorder === undefined ||
    options.commandRecorder === false
    ? NOOP_COMMAND_RECORDER
    : options.commandRecorder;
}

export interface CoreApiHost {
  readonly core: CoreAPI;
  readonly callbacks: SDKAPI;
  readonly closeAdmission: () => void;
  readonly dispose: (options?: ShutdownOptions) => Promise<void>;
}

function initialSnapshotFromOptions(
  options: CoreApiFactoryOptions,
): UiSnapshot | undefined {
  if (!options.mode && !options.permission) {
    return undefined;
  }

  return {
    activeSessionId: null,
    permission: {
      level: options.permission ?? "default",
      mode: options.mode ?? "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

function assertStartupOptions(options: CoreApiFactoryOptions): void {
  if (options.resume !== undefined && options.continue === true) {
    throw new Error("--resume and --continue cannot be used together");
  }
}

function createCoreAPIHost(options: CoreApiFactoryOptions): CoreApiHost {
  assertStartupOptions(options);

  const initialSnapshot = initialSnapshotFromOptions(options);
  const rawClient = createPersistentUiBackendClient({
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
    ...(options.continue === true
      ? { startupSessionMode: { type: "continue" as const } }
      : {}),
    ...(options.resume === undefined
      ? {}
      : { resumeSessionId: options.resume }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.diagnosticsFilePath === undefined
      ? {}
      : { diagnosticsFilePath: options.diagnosticsFilePath }),
  });
  const client = createUiCommandGateway(rawClient, {
    entryPoint: "agent-host",
    recorder: commandRecorderFromOptions(options),
  });
  let disposePromise: Promise<void> | undefined;
  const admission: { closeAdmission?(): void } = rawClient;
  const closeAdmission = (): void => {
    admission.closeAdmission?.();
  };

  return {
    callbacks: {
      subscribeEvents(handler): ReturnType<SDKAPI["subscribeEvents"]> {
        return rawClient.subscribeEvents(handler);
      },
    },
    core: client,
    closeAdmission,
    dispose(options = createShutdownOptions()): Promise<void> {
      if (disposePromise) return disposePromise;
      closeAdmission();
      try {
        beginDatabaseShutdown(options.deadlineAt);
      } catch (error) {
        if (!(error instanceof DatabaseNotInitializedError)) throw error;
      }
      disposePromise = collectCleanup(options, {
        backend: () => rawClient.dispose(options),
        mcp: () => McpManager.disposeAll(),
      })
        .then((result) => {
          if (result.status === "unconfirmed")
            throw new Error(result.errors.join("; "));
        })
        .finally(() => {
          closePersistentUiBackendDatabase();
        });
      return disposePromise;
    },
  };
}

export function buildCoreAPIImpl(
  options: CoreApiFactoryOptions = {},
): Promise<CoreApiHost> {
  return Promise.resolve().then(() => createCoreAPIHost(options));
}
