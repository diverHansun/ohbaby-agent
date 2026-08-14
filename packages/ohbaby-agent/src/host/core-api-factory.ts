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
  const name =
    diagnostic.error instanceof Error && diagnostic.error.name.length > 0
      ? diagnostic.error.name
      : "Error";
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
    core: {
      acquirePromptEditLease(
        input,
      ): ReturnType<CoreAPI["acquirePromptEditLease"]> {
        return client.acquirePromptEditLease(input);
      },
      abortRun(runId): ReturnType<CoreAPI["abortRun"]> {
        return client.abortRun(runId);
      },
      compactSession(compactOptions): ReturnType<CoreAPI["compactSession"]> {
        return client.compactSession(compactOptions);
      },
      archiveSession(input): ReturnType<CoreAPI["archiveSession"]> {
        return client.archiveSession(input);
      },
      cancelQueuedPrompt(
        input,
      ): ReturnType<CoreAPI["cancelQueuedPrompt"]> {
        return client.cancelQueuedPrompt(input);
      },
      probeModelContextWindow(
        input,
      ): ReturnType<CoreAPI["probeModelContextWindow"]> {
        return client.probeModelContextWindow(input);
      },
      connectModel(input): ReturnType<CoreAPI["connectModel"]> {
        return client.connectModel(input);
      },
      setSearchApiKey(input): ReturnType<CoreAPI["setSearchApiKey"]> {
        return client.setSearchApiKey(input);
      },
      setPermission(input): ReturnType<CoreAPI["setPermission"]> {
        return client.setPermission(input);
      },
      executeCommand(invocation): ReturnType<CoreAPI["executeCommand"]> {
        return client.executeCommand(invocation);
      },
      editQueuedPrompt(input): ReturnType<CoreAPI["editQueuedPrompt"]> {
        return client.editQueuedPrompt(input);
      },
      getSnapshot(): ReturnType<CoreAPI["getSnapshot"]> {
        return client.getSnapshot();
      },
      getContextWindowUsage(
        input,
      ): ReturnType<CoreAPI["getContextWindowUsage"]> {
        return client.getContextWindowUsage(input);
      },
      getCurrentModel(): ReturnType<CoreAPI["getCurrentModel"]> {
        return client.getCurrentModel();
      },
      listCommands(query): ReturnType<CoreAPI["listCommands"]> {
        return client.listCommands(query);
      },
      respondInteraction(
        interactionId,
        response,
      ): ReturnType<CoreAPI["respondInteraction"]> {
        return client.respondInteraction(interactionId, response);
      },
      respondPermission(
        requestId,
        response,
      ): ReturnType<CoreAPI["respondPermission"]> {
        return client.respondPermission(requestId, response);
      },
      releasePromptEditLease(
        input,
      ): ReturnType<CoreAPI["releasePromptEditLease"]> {
        return client.releasePromptEditLease(input);
      },
      renewPromptEditLease(
        input,
      ): ReturnType<CoreAPI["renewPromptEditLease"]> {
        return client.renewPromptEditLease(input);
      },
      submitPromptAccepted(
        text,
        submitOptions,
      ): ReturnType<CoreAPI["submitPromptAccepted"]> {
        return client.submitPromptAccepted(text, submitOptions);
      },
      submitPromptAndWait(
        text,
        submitOptions,
      ): ReturnType<CoreAPI["submitPromptAndWait"]> {
        return client.submitPromptAndWait(text, submitOptions);
      },
      waitForPrompt(
        promptId,
        waitOptions,
      ): ReturnType<CoreAPI["waitForPrompt"]> {
        return client.waitForPrompt(promptId, waitOptions);
      },
    },
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
