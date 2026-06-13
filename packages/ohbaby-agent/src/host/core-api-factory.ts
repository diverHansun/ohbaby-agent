import type { CoreAPI, SDKAPI, UiSnapshot } from "ohbaby-sdk";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
} from "../adapters/ui-persistent.js";
import { McpManager } from "../mcp/index.js";
import { createRemoteCoreApiHost } from "../runtime/daemon/client.js";
import type { DaemonStartupIntent } from "../runtime/daemon/protocol.js";
import {
  ensureDaemonRunning,
  type EnsureDaemonRunningOptions,
} from "../runtime/daemon/spawn.js";
import { getAgentPackageVersion } from "../package-version.js";

export interface CoreApiFactoryOptions {
  readonly continue?: boolean;
  readonly daemon?: boolean;
  readonly daemonPollIntervalMs?: number;
  readonly daemonSpawn?: EnsureDaemonRunningOptions["spawn"];
  readonly daemonStateFilePath?: string;
  readonly daemonTimeoutMs?: number;
  readonly inProcess?: boolean;
  readonly ensureDaemonRunning?: typeof ensureDaemonRunning;
  readonly mode?: "plan" | "auto";
  readonly permission?: "default" | "full-access";
  readonly remoteAuthToken?: string;
  readonly remoteHost?: string;
  readonly remotePort?: number;
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

function startupIntentFromOptions(
  options: CoreApiFactoryOptions,
): DaemonStartupIntent | undefined {
  const intent: DaemonStartupIntent = {
    ...(options.continue === true
      ? { startupSessionMode: { type: "continue" as const } }
      : {}),
    ...(options.resume === undefined ? {} : { resumeSessionId: options.resume }),
    ...(!options.mode && !options.permission
      ? {}
      : {
          initialPermission: {
            level: options.permission ?? "default",
            mode: options.mode ?? "auto",
          },
        }),
  };
  return Object.keys(intent).length === 0 ? undefined : intent;
}

export async function buildCoreAPIImpl(
  options: CoreApiFactoryOptions = {},
): Promise<CoreApiHost> {
  assertStartupOptions(options);
  const startupIntent = startupIntentFromOptions(options);

  if (options.remotePort !== undefined) {
    return createRemoteCoreApiHost({
      authToken: options.remoteAuthToken,
      host: options.remoteHost,
      port: options.remotePort,
      ...(startupIntent === undefined ? {} : { startupIntent }),
    });
  }

  if (options.inProcess !== true && options.daemon !== false) {
    const discoverDaemon = options.ensureDaemonRunning ?? ensureDaemonRunning;
    const connection = await discoverDaemon({
      currentVersion: getAgentPackageVersion(),
      ...(options.daemonPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.daemonPollIntervalMs }),
      ...(options.daemonSpawn === undefined ? {} : { spawn: options.daemonSpawn }),
      ...(options.daemonStateFilePath === undefined
        ? {}
        : { stateFilePath: options.daemonStateFilePath }),
      ...(options.daemonTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.daemonTimeoutMs }),
    });
    return createRemoteCoreApiHost({
      authToken: connection.authToken,
      host: connection.host,
      port: connection.port,
      ...(startupIntent === undefined ? {} : { startupIntent }),
    });
  }

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
      connectModel(input): ReturnType<CoreAPI["connectModel"]> {
        return client.connectModel(input);
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
