import process from "node:process";
import { resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
  getAgentPackageVersion,
  McpManager,
  type PersistentUiBackendClient,
  type PersistentUiBackendOptions,
} from "ohbaby-agent";
import { createDaemonAuthToken } from "../../auth/token.js";
import {
  createDaemonHttpServer,
  type DaemonHttpServerHandle,
} from "./server.js";
import { FilePidFile } from "./pid-file.js";
import { JsonDaemonStateFile } from "./state-file.js";
import { Supervisor } from "./supervisor.js";
import { fetchDaemonHealth, type DaemonHealthCheck } from "./health.js";
import { resolveDaemonScope } from "./scope.js";
import type { DaemonRuntimeHandle, DaemonState } from "./types.js";
import { isAddressInUseError } from "../../transport/node-listen.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export interface StartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly defaultPort?: number;
  readonly packageVersion?: string;
  readonly dbPath?: string;
  readonly healthCheck?: DaemonHealthCheck;
  readonly idleTimeoutMs?: number;
  readonly llmClient?: PersistentUiBackendOptions["llmClient"];
  readonly pidFilePath?: string;
  readonly stateFilePath?: string;
  readonly scopeRoot?: string;
  readonly webAssetsDir?: string;
  readonly workdir?: string;
}

export interface RunningDaemonServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly reused: boolean;
  readonly scopeRoot: string;
  stop(): Promise<void>;
}

export interface ReadDaemonStatusOptions {
  readonly workdir?: string;
}

type DaemonKill = (pid: number, signal: NodeJS.Signals) => unknown;

export interface StopDaemonFromStateOptions {
  readonly kill?: DaemonKill;
  readonly workdir?: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createServerRuntime(input: {
  readonly authToken: string;
  readonly backend: PersistentUiBackendClient;
  readonly packageVersion: string;
  readonly scopeRoot: string;
  readonly server: DaemonHttpServerHandle;
}): DaemonRuntimeHandle {
  return {
    get connection(): NonNullable<DaemonRuntimeHandle["connection"]> {
      return {
        authToken: input.authToken,
        host: input.server.host,
        packageVersion: input.packageVersion,
        port: input.server.port,
        scopeRoot: input.scopeRoot,
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

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function urlFromState(state: DaemonState): string | undefined {
  if (!state.host || !state.port) {
    return undefined;
  }
  return `http://${state.host}:${String(state.port)}`;
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  if (port === 0) {
    return true;
  }

  return new Promise<boolean>((resolveAvailable) => {
    const probe = createNetServer();
    let settled = false;
    const settle = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveAvailable(available);
    };

    probe.once("error", () => {
      settle(false);
    });
    probe.once("listening", () => {
      probe.close(() => {
        settle(true);
      });
    });
    probe.listen({ host, port });
  });
}

function assertRequestedEndpointMatchesState(input: {
  readonly explicitHost: boolean;
  readonly explicitPort: boolean;
  readonly requestedHost: string;
  readonly requestedPort: number;
  readonly state: DaemonState;
  readonly url: string;
}): void {
  const hostChanged =
    input.explicitHost && input.state.host !== input.requestedHost;
  const portChanged =
    input.explicitPort && input.state.port !== input.requestedPort;
  if (!hostChanged && !portChanged) {
    return;
  }

  throw new Error(
    `ohbaby server is already running for this project at ${input.url}. Stop it with ohbaby serve stop before changing host or port.`,
  );
}

async function resolveStartScope(options: StartDaemonServerOptions): Promise<{
  readonly pidFilePath: string;
  readonly scopeRoot: string;
  readonly stateFilePath: string;
}> {
  if (options.pidFilePath && options.stateFilePath) {
    return {
      pidFilePath: options.pidFilePath,
      scopeRoot: options.scopeRoot ?? resolve(options.workdir ?? process.cwd()),
      stateFilePath: options.stateFilePath,
    };
  }

  const scope = await resolveDaemonScope({ workdir: options.workdir });
  return {
    pidFilePath: options.pidFilePath ?? scope.pidFilePath,
    scopeRoot: options.scopeRoot ?? scope.scopeRoot,
    stateFilePath: options.stateFilePath ?? scope.stateFilePath,
  };
}

async function tryReuseRunningDaemon(input: {
  readonly explicitHost: boolean;
  readonly explicitPort: boolean;
  readonly healthCheck: DaemonHealthCheck;
  readonly requestedHost: string;
  readonly requestedPort: number;
  readonly scopeRoot: string;
  readonly stateFile: JsonDaemonStateFile;
}): Promise<RunningDaemonServer | undefined> {
  const state = await input.stateFile.read();
  if (
    state?.status !== "running" ||
    state.scopeRoot !== input.scopeRoot ||
    !isProcessAlive(state.pid)
  ) {
    return undefined;
  }

  const url = urlFromState(state);
  if (!url || !state.host || !state.port) {
    return undefined;
  }

  if (!(await input.healthCheck(state))) {
    throw new Error(
      `ohbaby server is running for this project at ${url}, but it did not answer the health check. Stop it with ohbaby serve stop, or remove ${input.scopeRoot}/.ohbaby/server if the process is stale.`,
    );
  }

  assertRequestedEndpointMatchesState({
    explicitHost: input.explicitHost,
    explicitPort: input.explicitPort,
    requestedHost: input.requestedHost,
    requestedPort: input.requestedPort,
    state,
    url,
  });

  return {
    host: state.host,
    port: state.port,
    reused: true,
    scopeRoot: input.scopeRoot,
    stop(): Promise<void> {
      return Promise.resolve();
    },
    url,
  };
}

async function startFreshDaemon(input: {
  readonly authToken: string;
  readonly options: StartDaemonServerOptions;
  readonly packageVersion: string;
  readonly pidFilePath: string;
  readonly port: number;
  readonly scopeRoot: string;
  readonly stateFilePath: string;
}): Promise<RunningDaemonServer> {
  let server: DaemonHttpServerHandle | undefined;
  const supervisor = new Supervisor({
    bootstrap(): DaemonRuntimeHandle {
      const backend = createPersistentUiBackendClient({
        ...(input.options.dbPath === undefined
          ? {}
          : { dbPath: input.options.dbPath }),
        ...(input.options.llmClient === undefined
          ? {}
          : { llmClient: input.options.llmClient }),
        workdir: input.options.workdir ?? input.scopeRoot,
      });
      server = createDaemonHttpServer({
        authToken: input.authToken,
        backend,
        host: input.options.host ?? DEFAULT_HOST,
        onClientConnected: (clientId) => {
          supervisor.clientConnected(clientId);
        },
        onClientDisconnected: (clientId) => {
          supervisor.clientDisconnected(clientId);
        },
        onShutdown: () => supervisor.stop(),
        packageVersion: input.packageVersion,
        port: input.port,
        webAssetsDir: input.options.webAssetsDir,
      });
      return createServerRuntime({
        authToken: input.authToken,
        backend,
        packageVersion: input.packageVersion,
        scopeRoot: input.scopeRoot,
        server,
      });
    },
    idleTimeoutMs: input.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    pidFilePath: input.pidFilePath,
    stateFilePath: input.stateFilePath,
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
    reused: false,
    scopeRoot: input.scopeRoot,
    stop(): Promise<void> {
      return supervisor.stop();
    },
    get url(): string {
      return startedServer.url;
    },
  };
}

export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<RunningDaemonServer> {
  const authToken = options.authToken ?? createDaemonAuthToken();
  const packageVersion = options.packageVersion ?? getAgentPackageVersion();
  const scope = await resolveStartScope(options);
  const healthCheck = options.healthCheck ?? fetchDaemonHealth;
  const stateFile = new JsonDaemonStateFile(scope.stateFilePath);
  const explicitHost = options.host !== undefined;
  const explicitPort = options.port !== undefined;
  const requestedHost = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? options.defaultPort ?? DEFAULT_PORT;
  const reusable = await tryReuseRunningDaemon({
    explicitHost,
    explicitPort,
    healthCheck,
    requestedHost,
    requestedPort,
    scopeRoot: scope.scopeRoot,
    stateFile,
  });
  if (reusable) {
    return reusable;
  }

  const firstPort =
    explicitPort || (await isPortAvailable(requestedHost, requestedPort))
      ? requestedPort
      : 0;

  try {
    return await startFreshDaemon({
      authToken,
      options,
      packageVersion,
      pidFilePath: scope.pidFilePath,
      port: firstPort,
      scopeRoot: scope.scopeRoot,
      stateFilePath: scope.stateFilePath,
    });
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error;
    }
    if (explicitPort) {
      throw new Error(
        `Port ${String(requestedPort)} is already in use for ${requestedHost}. Choose another port with --port, or stop the process currently using it.`,
        { cause: error },
      );
    }
    return startFreshDaemon({
      authToken,
      options,
      packageVersion,
      pidFilePath: scope.pidFilePath,
      port: 0,
      scopeRoot: scope.scopeRoot,
      stateFilePath: scope.stateFilePath,
    });
  }
}

export async function readDaemonStatus(
  options: ReadDaemonStatusOptions = {},
): Promise<DaemonState | undefined> {
  const scope = await resolveDaemonScope({ workdir: options.workdir });
  return new JsonDaemonStateFile(scope.stateFilePath).read();
}

function stateOwnsPidRecord(
  state: DaemonState,
  pidRecord: Awaited<ReturnType<FilePidFile["read"]>>,
): boolean {
  return (
    state.pid !== undefined &&
    state.pidToken !== undefined &&
    pidRecord?.pid === state.pid &&
    pidRecord.token === state.pidToken
  );
}

export async function stopDaemonFromState(
  options: StopDaemonFromStateOptions = {},
): Promise<"stopped" | "not-running"> {
  const scope = await resolveDaemonScope({ workdir: options.workdir });
  const state = await new JsonDaemonStateFile(scope.stateFilePath).read();
  if (
    state?.pid === undefined ||
    (state.status !== "running" && state.status !== "stopping")
  ) {
    return "not-running";
  }

  const pidRecord = await new FilePidFile(scope.pidFilePath).read();
  if (!stateOwnsPidRecord(state, pidRecord)) {
    if (pidRecord === undefined) {
      return "not-running";
    }
    throw new Error(
      `Refusing to stop daemon for ${scope.scopeRoot}: daemon state does not match the pid lock.`,
    );
  }

  try {
    (options.kill ?? process.kill)(state.pid, "SIGTERM");
    return "stopped";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return "not-running";
    }
    throw error;
  }
}
