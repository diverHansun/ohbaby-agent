import type { CoreAPI, SDKAPI, UiSnapshot } from "ohbaby-sdk";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "../adapters/ui-persistent.js";
import { McpManager } from "../mcp/index.js";

export interface CoreApiFactoryOptions {
  readonly continue?: boolean;
  readonly inProcess?: boolean;
  readonly mode?: "plan" | "auto";
  readonly permission?: "default" | "full-access";
  readonly resume?: string;
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
  const client = createPersistentUiBackendClient({
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
    ...(options.continue === true
      ? { startupSessionMode: { type: "continue" as const } }
      : {}),
    ...(options.resume === undefined
      ? {}
      : { resumeSessionId: options.resume }),
  });

  return {
    callbacks: {
      subscribeEvents(handler): ReturnType<SDKAPI["subscribeEvents"]> {
        return client.subscribeEvents(handler);
      },
    },
    core: {
      abortRun(runId): ReturnType<CoreAPI["abortRun"]> {
        return client.abortRun(runId);
      },
      compactSession(compactOptions): ReturnType<CoreAPI["compactSession"]> {
        return client.compactSession(compactOptions);
      },
      archiveSession(input): ReturnType<CoreAPI["archiveSession"]> {
        return client.archiveSession(input);
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
      submitPrompt(text, submitOptions): ReturnType<CoreAPI["submitPrompt"]> {
        return client.submitPrompt(text, submitOptions);
      },
    },
    async dispose(): Promise<void> {
      try {
        try {
          await client.dispose();
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
