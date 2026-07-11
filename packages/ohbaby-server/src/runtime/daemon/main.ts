import process from "node:process";
import { resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import {
  closePersistentUiBackendDatabase,
  createPersistentUiBackendClient,
  getAgentPackageVersion,
  listKnownSessionProjectRoots,
  McpManager,
  type PersistentUiBackendClient,
  type PersistentUiBackendOptions,
} from "ohbaby-agent";
import * as AgentRuntime from "ohbaby-agent";
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
const STARTUP_READINESS_TIMEOUT_MS = 2_000;
const STARTUP_READINESS_POLL_MS = 25;
let activeLocalDaemonDatabases = 0;

function retainLocalDaemonDatabase(): () => void {
  activeLocalDaemonDatabases += 1;
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    activeLocalDaemonDatabases = Math.max(0, activeLocalDaemonDatabases - 1);
    if (activeLocalDaemonDatabases === 0) {
      closePersistentUiBackendDatabase();
    }
  };
}

function createWorkspaceRegistryIfAvailable():
  | import("ohbaby-agent").WorkspaceRegistryStore
  | undefined {
  if (!("createWorkspaceRegistryStore" in AgentRuntime)) {
    return undefined;
  }
  try {
    return AgentRuntime.createWorkspaceRegistryStore();
  } catch (error) {
    // Unit tests may replace the persistent backend with a lightweight fake
    // that intentionally does not initialize SQLite.
    if (error instanceof Error && error.name === "DatabaseNotInitializedError") {
      return undefined;
    }
    throw error;
  }
}

export interface StartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly defaultPort?: number;
  readonly packageVersion?: string;
  readonly dbPath?: string;
  readonly healthCheck?: DaemonHealthCheck;
  readonly homeDirectory?: string;
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
  readonly homeDirectory?: string;
  readonly workdir?: string;
}

export interface DaemonConnectionInfo {
  readonly clientId: string;
  readonly connectedAt: number;
  readonly scopeKey: string;
}

export interface ListDaemonConnectionsOptions extends ReadDaemonStatusOptions {
  readonly fetch?: typeof fetch;
  readonly packageVersion?: string;
}

type DaemonKill = (pid: number, signal: NodeJS.Signals) => unknown;

export interface StopDaemonFromStateOptions {
  readonly homeDirectory?: string;
  readonly kill?: DaemonKill;
  readonly workdir?: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function createServerRuntime(input: {
  readonly authToken: string;
  readonly backend: PersistentUiBackendClient;
  readonly packageVersion: string;
  readonly releaseDatabase: () => void;
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
          input.releaseDatabase();
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

function urlWithWorkspaceHint(url: string, scopeRoot: string): string {
  const hinted = new URL(url);
  hinted.hash = new URLSearchParams({ directory: scopeRoot }).toString();
  return hinted.toString();
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
    `ohbaby server is already running globally at ${input.url}. Stop it with ohbaby serve stop before changing host or port.`,
  );
}

function assertPackageVersionMatches(input: {
  readonly packageVersion: string;
  readonly state: DaemonState;
  readonly url: string;
}): void {
  if (input.state.packageVersion === input.packageVersion) {
    return;
  }

  throw new Error(
    `ohbaby server version ${input.state.packageVersion ?? "unknown"} is already running at ${input.url}, but this CLI is version ${input.packageVersion}. Restart it explicitly with ohbaby serve stop, then ohbaby serve. The existing server was not stopped automatically.`,
  );
}

async function resolveStartScope(options: StartDaemonServerOptions): Promise<{
  readonly legacyPidFilePath?: string;
  readonly legacyStateFilePath?: string;
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

  const scope = await resolveDaemonScope({
    homeDirectory: options.homeDirectory,
    workdir: options.workdir,
  });
  return {
    legacyPidFilePath: scope.legacyPidFilePath,
    legacyStateFilePath: scope.legacyStateFilePath,
    pidFilePath: options.pidFilePath ?? scope.pidFilePath,
    scopeRoot: options.scopeRoot ?? scope.scopeRoot,
    stateFilePath: options.stateFilePath ?? scope.stateFilePath,
  };
}

async function assertNoLiveLegacyDaemon(input: {
  readonly legacyStateFilePath?: string;
  readonly scopeRoot: string;
}): Promise<void> {
  if (!input.legacyStateFilePath) {
    return;
  }

  const state = await new JsonDaemonStateFile(input.legacyStateFilePath).read();
  if (
    state?.status !== "running" ||
    state.pid === undefined ||
    !isProcessAlive(state.pid)
  ) {
    return;
  }

  throw new Error(
    `A legacy per-project ohbaby server is still running for ${input.scopeRoot}. Stop it explicitly with ohbaby serve stop from that project before starting the global server. It was not stopped automatically.`,
  );
}

async function tryReuseRunningDaemon(input: {
  readonly explicitHost: boolean;
  readonly explicitPort: boolean;
  readonly healthCheck: DaemonHealthCheck;
  readonly packageVersion: string;
  readonly pidRecord: Awaited<ReturnType<FilePidFile["read"]>>;
  readonly requestedHost: string;
  readonly requestedPort: number;
  readonly scopeRoot: string;
  readonly stateFile: JsonDaemonStateFile;
}): Promise<RunningDaemonServer | undefined> {
  const state = await input.stateFile.read();
  if (
    state?.status !== "running" ||
    input.pidRecord === undefined ||
    state.pid !== input.pidRecord.pid ||
    state.pidToken !== input.pidRecord.token ||
    !isProcessAlive(input.pidRecord.pid)
  ) {
    return undefined;
  }

  const url = urlFromState(state);
  if (!url || !state.host || !state.port) {
    return undefined;
  }

  assertPackageVersionMatches({
    packageVersion: input.packageVersion,
    state,
    url,
  });

  if (!(await input.healthCheck(state))) {
    throw new Error(
      `ohbaby server is running globally at ${url}, but it did not answer the health check. Stop it with ohbaby serve stop. If the process is stale, inspect the user-level ~/.ohbaby/server state before removing it.`,
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
    url: urlWithWorkspaceHint(url, input.scopeRoot),
  };
}

async function restoreWorkspaceInRunningDaemon(input: {
  readonly scopeRoot: string;
  readonly stateFile: JsonDaemonStateFile;
}): Promise<void> {
  const state = await input.stateFile.read();
  const url = state === undefined ? undefined : urlFromState(state);
  if (!url || !state?.authToken) {
    throw new Error("Global ohbaby server state is incomplete");
  }
  const response = await fetch(`${url}/v1/scopes/open`, {
    body: JSON.stringify({ directory: input.scopeRoot }),
    headers: {
      authorization: `Bearer ${state.authToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Could not restore ${input.scopeRoot} in the global project rail (HTTP ${String(response.status)})`,
    );
  }
}

async function waitForRunningDaemon(
  input: Parameters<typeof tryReuseRunningDaemon>[0],
): Promise<RunningDaemonServer> {
  const deadline = Date.now() + STARTUP_READINESS_TIMEOUT_MS;
  for (;;) {
    const reusable = await tryReuseRunningDaemon(input);
    if (reusable) {
      return reusable;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "ohbaby server owns the global pid file but did not become ready in time. It was not stopped automatically; inspect it with ohbaby serve status and restart it explicitly if needed.",
      );
    }
    await delay(STARTUP_READINESS_POLL_MS);
  }
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
      const createBackend = (workdir: string): PersistentUiBackendClient =>
        createPersistentUiBackendClient({
          ...(input.options.dbPath === undefined
            ? {}
            : { dbPath: input.options.dbPath }),
          ...(input.options.llmClient === undefined
            ? {}
            : { llmClient: input.options.llmClient }),
          workdir,
        });
      const backend = createBackend(input.scopeRoot);
      const releaseDatabase = retainLocalDaemonDatabase();
      const workspaceRegistry = createWorkspaceRegistryIfAvailable();
      workspaceRegistry?.open(input.scopeRoot);
      server = createDaemonHttpServer({
        authToken: input.authToken,
        backend,
        createWorkspaceBackend: createBackend,
        host: input.options.host ?? DEFAULT_HOST,
        listKnownWorkspaceScopes: () => listKnownSessionProjectRoots(),
        workspaceRegistry,
        directoryPickerHome: input.options.homeDirectory,
        onClientConnected: (clientId) => {
          supervisor.clientConnected(clientId);
        },
        onClientDisconnected: (clientId) => {
          supervisor.clientDisconnected(clientId);
        },
        onShutdown: () => supervisor.stop(),
        packageVersion: input.packageVersion,
        port: input.port,
        scopeRoot: input.scopeRoot,
        webAssetsDir: input.options.webAssetsDir,
      });
      return createServerRuntime({
        authToken: input.authToken,
        backend,
        packageVersion: input.packageVersion,
        releaseDatabase,
        scopeRoot: input.scopeRoot,
        server,
      });
    },
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
      return urlWithWorkspaceHint(startedServer.url, input.scopeRoot);
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
  const pidRecord = await new FilePidFile(scope.pidFilePath).read();
  const explicitHost = options.host !== undefined;
  const explicitPort = options.port !== undefined;
  const requestedHost = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? options.defaultPort ?? DEFAULT_PORT;
  await assertNoLiveLegacyDaemon({
    legacyStateFilePath: scope.legacyStateFilePath,
    scopeRoot: scope.scopeRoot,
  });
  const reusable = await tryReuseRunningDaemon({
    explicitHost,
    explicitPort,
    healthCheck,
    packageVersion,
    pidRecord,
    requestedHost,
    requestedPort,
    scopeRoot: scope.scopeRoot,
    stateFile,
  });
  if (reusable) {
    if (options.healthCheck === undefined) {
      await restoreWorkspaceInRunningDaemon({
        scopeRoot: scope.scopeRoot,
        stateFile,
      });
    }
    return reusable;
  }
  if (pidRecord !== undefined && isProcessAlive(pidRecord.pid)) {
    const running = await waitForRunningDaemon({
      explicitHost,
      explicitPort,
      healthCheck,
      packageVersion,
      pidRecord,
      requestedHost,
      requestedPort,
      scopeRoot: scope.scopeRoot,
      stateFile,
    });
    if (options.healthCheck === undefined) {
      await restoreWorkspaceInRunningDaemon({
        scopeRoot: scope.scopeRoot,
        stateFile,
      });
    }
    return running;
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
  const scope = await resolveDaemonScope({
    homeDirectory: options.homeDirectory,
    workdir: options.workdir,
  });
  const globalState = await new JsonDaemonStateFile(scope.stateFilePath).read();
  if (globalState !== undefined) {
    return globalState;
  }
  return new JsonDaemonStateFile(scope.legacyStateFilePath).read();
}

function isDaemonConnectionInfo(value: unknown): value is DaemonConnectionInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "clientId" in value &&
    typeof value.clientId === "string" &&
    "connectedAt" in value &&
    typeof value.connectedAt === "number" &&
    "scopeKey" in value &&
    typeof value.scopeKey === "string"
  );
}

export async function listDaemonConnections(
  options: ListDaemonConnectionsOptions = {},
): Promise<readonly DaemonConnectionInfo[]> {
  const scope = await resolveDaemonScope({
    homeDirectory: options.homeDirectory,
    workdir: options.workdir,
  });
  const state = await new JsonDaemonStateFile(scope.stateFilePath).read();
  if (state?.status !== "running") {
    return [];
  }
  const url = urlFromState(state);
  if (!url || !state.authToken) {
    throw new Error("Global ohbaby server state is incomplete");
  }
  assertPackageVersionMatches({
    packageVersion: options.packageVersion ?? getAgentPackageVersion(),
    state,
    url,
  });
  const response = await (options.fetch ?? globalThis.fetch)(
    `${url}/v1/connections`,
    {
      headers: { authorization: `Bearer ${state.authToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not read ohbaby server connections (HTTP ${String(response.status)})`,
    );
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("connections" in body) ||
    !Array.isArray(body.connections) ||
    !body.connections.every(isDaemonConnectionInfo)
  ) {
    throw new Error("ohbaby server returned an invalid connections response");
  }
  return body.connections;
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
  const scope = await resolveDaemonScope({
    homeDirectory: options.homeDirectory,
    workdir: options.workdir,
  });
  const globalState = await new JsonDaemonStateFile(scope.stateFilePath).read();
  const useLegacyState = globalState === undefined;
  const state =
    globalState ??
    (await new JsonDaemonStateFile(scope.legacyStateFilePath).read());
  if (
    state?.pid === undefined ||
    (state.status !== "running" && state.status !== "stopping")
  ) {
    return "not-running";
  }

  const pidFilePath = useLegacyState
    ? scope.legacyPidFilePath
    : scope.pidFilePath;
  const pidRecord = await new FilePidFile(pidFilePath).read();
  if (!stateOwnsPidRecord(state, pidRecord)) {
    if (pidRecord === undefined) {
      return "not-running";
    }
    throw new Error(
      `Refusing to stop ${useLegacyState ? "legacy project" : "global"} daemon: daemon state does not match the pid lock.`,
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
