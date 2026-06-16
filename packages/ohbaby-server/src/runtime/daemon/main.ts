import process from "node:process";
import { resolve } from "node:path";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
  getAgentPackageVersion,
  McpManager,
  type PersistentUiBackendClient,
  type PersistentUiBackendOptions,
} from "ohbaby-agent";
import { createDaemonAuthToken } from "../../auth/token.js";
import { createDaemonHttpServer, type DaemonHttpServerHandle } from "./server.js";
import { JsonDaemonStateFile } from "./state-file.js";
import { Supervisor } from "./supervisor.js";
import type { DaemonRuntimeHandle, DaemonState } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_STATE_DIR = ".ohbaby";
const DEFAULT_STATE_FILE = resolve(DEFAULT_STATE_DIR, "daemon-state.json");
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface StartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly packageVersion?: string;
  readonly dbPath?: string;
  readonly idleTimeoutMs?: number;
  readonly llmClient?: PersistentUiBackendOptions["llmClient"];
  readonly pidFilePath?: string;
  readonly stateFilePath?: string;
  readonly workdir?: string;
}

export interface RunningDaemonServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createServerRuntime(input: {
  readonly authToken: string;
  readonly backend: PersistentUiBackendClient;
  readonly packageVersion: string;
  readonly server: DaemonHttpServerHandle;
}): DaemonRuntimeHandle {
  return {
    get connection(): NonNullable<DaemonRuntimeHandle["connection"]> {
      return {
        authToken: input.authToken,
        host: input.server.host,
        packageVersion: input.packageVersion,
        port: input.server.port,
      };
    },
    start(): Promise<void> {
      return input.server.start();
    },
    async stop(): Promise<void> {
      try {
        await input.server.stop();
      } finally {
        try {
          try {
            await input.backend.dispose();
          } finally {
            await McpManager.disposeAll();
          }
        } finally {
          closePersistentUiBackendDatabase();
        }
      }
    },
  };
}

export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<RunningDaemonServer> {
  let server: DaemonHttpServerHandle | undefined;
  const authToken = options.authToken ?? createDaemonAuthToken();
  const packageVersion = options.packageVersion ?? getAgentPackageVersion();
  const supervisor = new Supervisor({
    bootstrap(): DaemonRuntimeHandle {
      const backend = createPersistentUiBackendClient({
        backendLeaseMode: "disabled",
        ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
        ...(options.llmClient === undefined
          ? {}
          : { llmClient: options.llmClient }),
        ...(options.workdir === undefined ? {} : { workdir: options.workdir }),
      });
      server = createDaemonHttpServer({
        authToken,
        backend,
        host: options.host ?? DEFAULT_HOST,
        onClientConnected: (clientId) => {
          supervisor.clientConnected(clientId);
        },
        onClientDisconnected: (clientId) => {
          supervisor.clientDisconnected(clientId);
        },
        onShutdown: () => supervisor.stop(),
        packageVersion,
        port: options.port ?? DEFAULT_PORT,
      });
      return createServerRuntime({ authToken, backend, packageVersion, server });
    },
    ...(options.pidFilePath === undefined
      ? {}
      : { pidFilePath: options.pidFilePath }),
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(options.stateFilePath === undefined
      ? {}
      : { stateFilePath: options.stateFilePath }),
  });

  await supervisor.start();
  const startedServer = server;
  if (!startedServer) {
    throw new Error("daemon server failed to initialize");
  }

  return {
    get host(): string {
      return startedServer.host;
    },
    get port(): number {
      return startedServer.port;
    },
    stop(): Promise<void> {
      return supervisor.stop();
    },
    get url(): string {
      return startedServer.url;
    },
  };
}

export async function readDaemonStatus(): Promise<DaemonState | undefined> {
  return new JsonDaemonStateFile(DEFAULT_STATE_FILE).read();
}

export async function stopDaemonFromState(): Promise<"stopped" | "not-running"> {
  const state = await readDaemonStatus();
  if (
    state?.pid === undefined ||
    (state.status !== "running" && state.status !== "stopping")
  ) {
    return "not-running";
  }

  try {
    process.kill(state.pid, "SIGTERM");
    return "stopped";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return "not-running";
    }
    throw error;
  }
}
