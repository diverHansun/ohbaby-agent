import type {
  CoreAPI,
  SDKAPI,
  UiCommandObservationDiagnostic,
  UiCommandRecorder,
  UiSnapshot,
} from "ohbaby-sdk";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "../adapters/ui-persistent.js";
import { McpManager } from "../mcp/index.js";
import {
  createStructuredUiCommandRecorder,
  type StructuredUiCommandRecorder,
} from "./command-recorder.js";
import { createUiCommandGateway } from "./ui-command-gateway.js";

export interface CoreApiFactoryOptions {
  readonly commandRecorder?: UiCommandRecorder | false;
  readonly continue?: boolean;
  readonly inProcess?: boolean;
  readonly mode?: "plan" | "auto";
  readonly permission?: "default" | "full-access";
  readonly resume?: string;
}

const NOOP_COMMAND_RECORDER: UiCommandRecorder = {
  record(): void {
    return;
  },
};

function reportCommandObservationFailure(
  diagnostic: UiCommandObservationDiagnostic,
): void {
  const name = diagnostic.error instanceof Error ? "Error" : "NonError";
  process.stderr.write(
    `${JSON.stringify({ name, stage: diagnostic.stage, type: "ui.command.observation.failure" })}\n`,
  );
}

function commandRecorderFromOptions(options: CoreApiFactoryOptions): {
  readonly recorder: UiCommandRecorder;
  readonly structured?: StructuredUiCommandRecorder;
} {
  if (options.commandRecorder === false) {
    return { recorder: NOOP_COMMAND_RECORDER };
  }
  if (options.commandRecorder !== undefined) {
    return { recorder: options.commandRecorder };
  }
  if (process.env.NODE_ENV === "test") {
    return { recorder: NOOP_COMMAND_RECORDER };
  }
  const structured = createStructuredUiCommandRecorder();
  return { recorder: structured, structured };
}

export interface CoreApiHost {
  readonly core: CoreAPI;
  readonly callbacks: SDKAPI;
  readonly dispose: () => Promise<void>;
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
  });
  const commandRecording = commandRecorderFromOptions(options);
  const client = createUiCommandGateway(rawClient, {
    entryPoint: "agent-host",
    onDiagnostic: reportCommandObservationFailure,
    recorder: commandRecording.recorder,
  });

  return {
    callbacks: {
      subscribeEvents(handler): ReturnType<SDKAPI["subscribeEvents"]> {
        return rawClient.subscribeEvents(handler);
      },
    },
    core: client,
    async dispose(): Promise<void> {
      try {
        try {
          await rawClient.dispose();
          await commandRecording.structured?.flush();
        } finally {
          await McpManager.disposeAll();
        }
      } finally {
        closePersistentUiBackendDatabase();
      }
    },
  };
}

export function buildCoreAPIImpl(
  options: CoreApiFactoryOptions = {},
): Promise<CoreApiHost> {
  return Promise.resolve().then(() => createCoreAPIHost(options));
}
