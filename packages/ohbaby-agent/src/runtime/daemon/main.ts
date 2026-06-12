import process from "node:process";
import { resolve } from "node:path";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
  type PersistentUiBackendClient,
} from "../../adapters/ui-persistent.js";
import { createDaemonHttpServer, type DaemonHttpServerHandle } from "./server.js";
import { JsonDaemonStateFile } from "./state-file.js";
import { Supervisor } from "./supervisor.js";
import type { DaemonRuntimeHandle, DaemonState } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_STATE_DIR = ".ohbaby";
const DEFAULT_STATE_FILE = resolve(DEFAULT_STATE_DIR, "daemon-state.json");

export interface StartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
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
  readonly backend: PersistentUiBackendClient;
  readonly server: DaemonHttpServerHandle;
}): DaemonRuntimeHandle {
  return {
    start(): Promise<void> {
      return input.server.start();
    },
    async stop(): Promise<void> {
      try {
        await input.server.stop();
      } finally {
        try {
          await input.backend.dispose();
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
  const supervisor = new Supervisor({
    bootstrap(): DaemonRuntimeHandle {
      const backend = createPersistentUiBackendClient({
        ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
      });
      server = createDaemonHttpServer({
        backend,
        host: options.host ?? DEFAULT_HOST,
        port: options.port ?? DEFAULT_PORT,
      });
      return createServerRuntime({ backend, server });
    },
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
