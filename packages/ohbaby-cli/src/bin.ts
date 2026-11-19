#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoreAPI, DaemonStartupIntent } from "ohbaby-sdk";
import { createRPC } from "ohbaby-sdk";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { createRunCommand } from "./cli/commands/run.js";
import { createServeCommand } from "./cli/commands/serve.js";
import { createTerminalCommand } from "./cli/commands/terminal.js";
import { createUninstallCommand } from "./cli/commands/uninstall.js";
import {
  createUpdateCommand,
  runAutomaticUpdate,
} from "./cli/commands/update.js";
import type {
  CliCommandRuntime,
  CliCoreHost,
  CliCoreHostResult,
  CliGlobalOptions,
  CliStartupUpdate,
  CliWritable,
} from "./cli/commands/types.js";
import { readAutoUpdate } from "./update/settings.js";
import {
  runUpgradePreflight,
  type UpgradePreflightRuntime,
} from "./update/preflight.js";
import {
  readUpdateNotice,
  refreshVersionCacheInBackground,
} from "./update/version-check.js";
import { EXIT_CODES } from "./cli/exit-codes.js";
import { readStdin } from "./cli/stdin.js";
import { createStdoutRenderer } from "./cli/stdout-renderer.js";
import { getCliPackageVersion } from "./package-version.js";
import { readServeCoexistenceNotice } from "./serve-awareness.js";
import { renderTerminalUi } from "./tui/index.js";
import { prepareTerminalUi } from "./tui/prepare.js";
import type {
  DiagnosticEventDefinition,
  LoadRuntimeEnvOptions,
  LoadRuntimeEnvResult,
  Logger,
  OhbabyMigrationReport,
  ProcessLoggerHandle,
  ShutdownOptions,
  collectCleanup,
  createShutdownOptions,
  resolveOhbabyHome,
} from "ohbaby-agent";
import { StartupNoticeBuffer } from "./cli/startup-notice-buffer.js";

const VERSION = getCliPackageVersion();
const AGENT_RUNTIME_MODULE = "ohbaby-agent";
const SERVER_RUNTIME_MODULE = "ohbaby-server";

type RealpathResolver = (path: string) => string;

export function isDirectCliInvocation(
  moduleUrl: string,
  argvEntry: string | undefined,
  realpath: RealpathResolver = realpathSync.native,
): boolean {
  if (argvEntry === undefined) {
    return false;
  }
  if (moduleUrl === pathToFileURL(argvEntry).href) {
    return true;
  }
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(argvEntry);
  } catch {
    return false;
  }
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const DATABASE_NEWER_THAN_PROGRAM = "DATABASE_NEWER_THAN_PROGRAM";

/** Matches by structural code because the error class may come from another package copy. */
function findDatabaseNewerThanProgram(error: unknown): Error | undefined {
  for (let current = error, depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    if ((current as { code?: unknown }).code === DATABASE_NEWER_THAN_PROGRAM) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

const AUTO_UPDATE_HINT =
  "Run ohbaby update --auto on to enable automatic updates.";

/**
 * Startup update hooks for the local TUI and `serve start`. The cache reads stay
 * offline; only automatic update initializes the proxy, right before it runs.
 */
function createStartupUpdate(input: {
  readonly resolveOhbabyHome: () => string;
  readonly initializeProxy: () => Promise<void>;
  readonly runtime: () => CliCommandRuntime;
  readonly pushStartupNotice: (message: string) => void;
}): CliStartupUpdate {
  const readNotice = (
    ohbabyHome: string,
  ): ReturnType<typeof readUpdateNotice> =>
    readUpdateNotice({ ohbabyHome, currentVersion: VERSION });
  return {
    readNotice(): string | undefined {
      const ohbabyHome = input.resolveOhbabyHome();
      const notice = readNotice(ohbabyHome);
      if (notice === undefined) return undefined;
      return readAutoUpdate(ohbabyHome)
        ? notice.message
        : `${notice.message} ${AUTO_UPDATE_HINT}`;
    },
    async runAutomaticUpdate(): Promise<"continue" | "exit"> {
      const ohbabyHome = input.resolveOhbabyHome();
      if (!readAutoUpdate(ohbabyHome)) return "continue";
      const notice = readNotice(ohbabyHome);
      if (notice === undefined) return "continue";
      await input.initializeProxy();
      const runtime = input.runtime();
      const messages: string[] = [];
      const decision = await runAutomaticUpdate({
        ohbabyHome,
        currentVersion: VERSION,
        targetVersion: notice.latestVersion,
        runtime: {
          ...runtime,
          stderr: {
            write(chunk: string): void {
              messages.push(chunk);
              runtime.stderr.write(chunk);
            },
          },
        },
      });
      if (decision === "continue") {
        // The TUI clears the screen on start, so repeat the reason inside it.
        for (const line of messages.join("").split("\n")) {
          if (line.trim().length > 0) input.pushStartupNotice(line);
        }
      }
      return decision;
    },
    refreshInBackground(): void {
      refreshVersionCacheInBackground({
        ohbabyHome: input.resolveOhbabyHome(),
      });
    },
  };
}

export interface RunOhbabyCliIo {
  readonly stderr?: CliWritable;
  readonly stdin?: Readable & { readonly isTTY?: boolean };
  readonly stdout?: CliWritable;
}

interface NetworkProxyHandle {
  dispose(): Promise<void>;
}
type InstallSystemProxy = (options?: {
  readonly onStatus?: (message: string) => void;
}) => Promise<NetworkProxyHandle>;

export interface RunOhbabyCliDependencies {
  readonly installSystemProxy?: InstallSystemProxy;
  readonly onHostShutdownComplete?: () => void;
  readonly createCoreHost?: (options: CliGlobalOptions) => CliCoreHostResult;
  readonly listDaemonConnections?: NonNullable<
    CliCommandRuntime["listDaemonConnections"]
  >;
  readonly loadRuntimeEnvIntoProcessEnv?: (
    options?: LoadRuntimeEnvOptions,
  ) => Promise<void> | void;
  readonly openUrl?: CliCommandRuntime["openUrl"];
  readonly readServeCoexistenceNotice?: () => Promise<string | undefined>;
  /** Enables startup update checks; injected tests opt in explicitly. */
  readonly resolveOhbabyHome?: () => string;
  readonly resolveOhbabyDataPaths?: CliCommandRuntime["resolveOhbabyDataPaths"];
  readonly runUpgradePreflight?: CliCommandRuntime["runUpgradePreflight"];
  readonly readDaemonStatus?: CliCommandRuntime["readDaemonStatus"];
  readonly startDaemonServer?: (
    options: Parameters<CliCommandRuntime["startDaemonServer"]>[0] & {
      readonly beforeBackendStart?: () => Promise<void>;
      readonly backendCleanup?: () => Promise<void>;
    },
  ) => ReturnType<CliCommandRuntime["startDaemonServer"]>;
  readonly stopDaemonFromState?: CliCommandRuntime["stopDaemonFromState"];
}

interface RemoteDaemonClientOptions {
  readonly authToken?: string;
  readonly directory?: string;
  readonly host?: string;
  readonly port: number;
  readonly startupIntent?: DaemonStartupIntent;
}

interface AgentRuntimeModule {
  readonly OHBABY_DATABASE_FILE_NAME?: unknown;
  readonly resolveOhbabyDataRoot?: unknown;
  readonly installSystemProxy?: unknown;
  readonly collectCleanup?: typeof collectCleanup;
  readonly createShutdownOptions?: typeof createShutdownOptions;
  readonly buildCoreAPIImpl?: unknown;
  readonly configMigrationCompleted?: unknown;
  readonly createProcessLogger?: unknown;
  readonly dataMigrationCompleted?: unknown;
  readonly durationClockAnomaly?: unknown;
  readonly loadRuntimeEnvIntoProcessEnv?: unknown;
  readonly migrateOhbabyData?: unknown;
  readonly resolveOhbabyHome?: typeof resolveOhbabyHome;
}

type AgentCoreFactoryOptions = CliGlobalOptions & {
  readonly watchModelConfig?: boolean;
  readonly diagnosticsFilePath?: string;
  readonly logger?: Logger;
};

type DefaultStartDaemonServerOptions = Parameters<
  NonNullable<CliCommandRuntime["startDaemonServer"]>
>[0] & {
  readonly beforeBackendStart?: () => Promise<void>;
  readonly backendCleanup?: () => Promise<void>;
  readonly diagnosticsFactory?: (context: {
    readonly ohbabyHome: string;
    readonly workspaceRoot: string;
  }) => Promise<ProcessLoggerHandle | undefined>;
  readonly onDataMigrationReport?: (report: OhbabyMigrationReport) => void;
};

type DefaultStartDaemonServer = (
  options: DefaultStartDaemonServerOptions,
) => ReturnType<NonNullable<CliCommandRuntime["startDaemonServer"]>>;

interface MigrationCounts {
  readonly conflicts: number;
  readonly copied: number;
  readonly merged: number;
  readonly skipped: number;
}

function migrationCounts(report: OhbabyMigrationReport): MigrationCounts {
  return {
    conflicts: report.conflicts.length,
    copied: report.copied.length,
    merged: report.merged.length,
    skipped: report.skipped.length,
  };
}

function emitWithoutAffectingProduct<Input>(
  logger: Logger,
  definition: DiagnosticEventDefinition<Input>,
  input: NoInfer<Input>,
): void {
  try {
    logger.emit(definition, input);
  } catch {
    // Injected diagnostics cannot change CLI startup or migration semantics.
  }
}

interface ServerRuntimeModule {
  readonly createRemoteCoreApiHost?: unknown;
  readonly inspectDaemonForMaintenance?: unknown;
  readonly listDaemonConnections?: unknown;
  readonly readDaemonStatus?: unknown;
  readonly startDaemonServer?: unknown;
  readonly stopDaemonFromState?: unknown;
}

function createRpcCoreHost(host: CliCoreHost): CliCoreHost {
  const rpc = createRPC<CoreAPI>();
  rpc.connectImpl(host.core);
  return {
    reportDurationClockAnomaly: host.reportDurationClockAnomaly,
    callbacks: host.callbacks,
    core: rpc.createProxy(host.callbacks),
    dispose: host.dispose,
    closeAdmission: host.closeAdmission,
    ...(host.diagnosticsFilePath === undefined
      ? {}
      : { diagnosticsFilePath: host.diagnosticsFilePath }),
    ...(host.diagnosticsUnavailable === undefined
      ? {}
      : { diagnosticsUnavailable: host.diagnosticsUnavailable }),
    ...(host.subscribeDiagnosticsUnavailable === undefined
      ? {}
      : {
          subscribeDiagnosticsUnavailable: host.subscribeDiagnosticsUnavailable,
        }),
  };
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
  // eslint-disable-next-line no-restricted-syntax -- Audited composition-root runtime loader; all other CLI variable imports are forbidden.
  return import(specifier);
}

function requireFunction(
  value: unknown,
  name: string,
  moduleName: string,
): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Missing ${name} export from ${moduleName}`);
  }
  return value as (...args: unknown[]) => unknown;
}

type RuntimeExportFunction = (...args: unknown[]) => unknown;

function optionalRuntimeExport(
  runtimeModule: Record<string, unknown>,
  name: string,
): RuntimeExportFunction | undefined {
  const value = Object.prototype.hasOwnProperty.call(runtimeModule, name)
    ? runtimeModule[name]
    : undefined;
  return typeof value === "function"
    ? (value as RuntimeExportFunction)
    : undefined;
}

function missingRuntimeDependency(name: string): never {
  throw new Error(`CLI runtime dependency ${name} was not initialized`);
}

async function openUrlWithSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function assertStartupOptions(options: CliGlobalOptions): void {
  if (options.resume !== undefined && options.continue === true) {
    throw new Error("--resume and --continue cannot be used together");
  }
}

function startupIntentFromOptions(
  options: CliGlobalOptions,
): DaemonStartupIntent {
  return {
    ...(options.continue === true
      ? { startupSessionMode: { type: "continue" as const } }
      : { startupSessionMode: { type: "fresh" as const } }),
    ...(options.resume === undefined
      ? {}
      : { resumeSessionId: options.resume }),
    ...(!options.mode && !options.permission
      ? {}
      : {
          initialPermission: {
            level: options.permission ?? "default",
            mode: options.mode ?? "auto",
          },
        }),
  };
}

function remoteHostOptionsFromCliOptions(
  options: CliGlobalOptions,
): RemoteDaemonClientOptions | undefined {
  if (options.remotePort === undefined) {
    return undefined;
  }
  assertStartupOptions(options);
  return {
    ...(options.remoteAuthToken === undefined
      ? {}
      : { authToken: options.remoteAuthToken }),
    directory: process.cwd(),
    host: options.remoteHost,
    port: options.remotePort,
    startupIntent: startupIntentFromOptions(options),
  };
}

async function loadDefaultDependencies(
  onServeDiagnosticsUnavailable: () => void,
): Promise<RunOhbabyCliDependencies> {
  const runtimeModule = (await importRuntimeModule(
    AGENT_RUNTIME_MODULE,
  )) as AgentRuntimeModule;
  const buildCoreAPIImpl = requireFunction(
    runtimeModule.buildCoreAPIImpl,
    "buildCoreAPIImpl",
    AGENT_RUNTIME_MODULE,
  ) as (options: AgentCoreFactoryOptions) => CliCoreHost | Promise<CliCoreHost>;
  const createProcessLogger = (options: {
    readonly ohbabyHome?: string;
    readonly onUnavailable?: () => void;
    readonly role: "serve" | "tui";
    readonly workspaceRoot: string;
  }): Promise<ProcessLoggerHandle> => {
    const createLogger = requireFunction(
      runtimeModule.createProcessLogger,
      "createProcessLogger",
      AGENT_RUNTIME_MODULE,
    ) as (input: typeof options) => Promise<ProcessLoggerHandle>;
    return createLogger(options);
  };
  const loadRuntimeEnvIntoProcessEnv = requireFunction(
    runtimeModule.loadRuntimeEnvIntoProcessEnv,
    "loadRuntimeEnvIntoProcessEnv",
    AGENT_RUNTIME_MODULE,
  ) as (
    options?: LoadRuntimeEnvOptions,
  ) => Promise<LoadRuntimeEnvResult> | LoadRuntimeEnvResult;
  const migrateOhbabyDataExport = optionalRuntimeExport(
    runtimeModule as Record<string, unknown>,
    "migrateOhbabyData",
  );
  const migrateOhbabyData =
    typeof migrateOhbabyDataExport === "function"
      ? (migrateOhbabyDataExport as () =>
          | Promise<OhbabyMigrationReport>
          | OhbabyMigrationReport)
      : undefined;
  let runtimeEnvResult: LoadRuntimeEnvResult | undefined;

  let serverRuntimePromise: Promise<ServerRuntimeModule> | undefined;
  const loadServerRuntimeModule = (): Promise<ServerRuntimeModule> => {
    serverRuntimePromise ??= importRuntimeModule(
      SERVER_RUNTIME_MODULE,
    ) as Promise<ServerRuntimeModule>;
    return serverRuntimePromise;
  };
  const requireServerFunction = async (
    name: keyof ServerRuntimeModule,
  ): Promise<(...args: unknown[]) => unknown> => {
    const serverModule = await loadServerRuntimeModule();
    return requireFunction(
      optionalRuntimeExport(serverModule as Record<string, unknown>, name),
      name,
      SERVER_RUNTIME_MODULE,
    );
  };

  const resolveHomeExport = optionalRuntimeExport(
    runtimeModule as Record<string, unknown>,
    "resolveOhbabyHome",
  ) as typeof resolveOhbabyHome | undefined;

  return {
    ...(resolveHomeExport === undefined
      ? {}
      : { resolveOhbabyHome: (): string => resolveHomeExport() }),
    resolveOhbabyDataPaths() {
      const resolveDataRoot = requireFunction(
        runtimeModule.resolveOhbabyDataRoot,
        "resolveOhbabyDataRoot",
        AGENT_RUNTIME_MODULE,
      ) as () => string;
      const databaseName = runtimeModule.OHBABY_DATABASE_FILE_NAME;
      if (typeof databaseName !== "string") {
        throw new Error("Missing database file name from ohbaby-agent");
      }
      const dataRoot = resolveDataRoot();
      const configuredDatabase = process.env.OHBABY_DB_PATH;
      return {
        dataRoot,
        databasePath:
          configuredDatabase === undefined
            ? join(dataRoot, databaseName)
            : resolve(configuredDatabase),
      };
    },
    async runUpgradePreflight(options) {
      if (!resolveHomeExport) {
        throw new Error("Missing resolveOhbabyHome export from ohbaby-agent");
      }
      const inspectDaemonForMaintenance = (await requireServerFunction(
        "inspectDaemonForMaintenance",
      )) as UpgradePreflightRuntime["inspectDaemonForMaintenance"];
      const stopDaemonFromState = (await requireServerFunction(
        "stopDaemonFromState",
      )) as UpgradePreflightRuntime["stopDaemonFromState"];
      return runUpgradePreflight(options, {
        resolveOhbabyHome: resolveHomeExport,
        inspectDaemonForMaintenance,
        stopDaemonFromState,
      });
    },
    readServeCoexistenceNotice(): Promise<string | undefined> {
      const resolveHome = runtimeModule.resolveOhbabyHome;
      return resolveHome
        ? readServeCoexistenceNotice({ packageVersion: VERSION }, resolveHome)
        : Promise.resolve(undefined);
    },
    installSystemProxy: requireFunction(
      runtimeModule.installSystemProxy,
      "installSystemProxy",
      AGENT_RUNTIME_MODULE,
    ) as InstallSystemProxy,
    async createCoreHost(options): Promise<CliCoreHost> {
      const { diagnosticsRole, ...agentOptions } = options;
      const remoteOptions = remoteHostOptionsFromCliOptions(options);
      if (remoteOptions !== undefined) {
        const createRemoteCoreApiHost = (await requireServerFunction(
          "createRemoteCoreApiHost",
        )) as (
          remoteOptions: RemoteDaemonClientOptions,
        ) => CliCoreHost | Promise<CliCoreHost>;
        return createRemoteCoreApiHost(remoteOptions);
      }
      if (diagnosticsRole !== "tui") {
        if (migrateOhbabyData !== undefined) {
          await migrateOhbabyData();
        }
        return buildCoreAPIImpl(agentOptions);
      }
      let diagnosticsUnavailable = false;
      let diagnosticsUnavailablePresented = false;
      const diagnosticsUnavailableListeners = new Set<() => void>();
      const handle = await createProcessLogger({
        onUnavailable(): void {
          if (diagnosticsUnavailable) {
            return;
          }
          diagnosticsUnavailable = true;
          if (diagnosticsUnavailableListeners.size > 0) {
            diagnosticsUnavailablePresented = true;
          }
          for (const listener of diagnosticsUnavailableListeners) {
            listener();
          }
        },
        role: "tui",
        workspaceRoot: runtimeEnvResult?.projectRoot ?? process.cwd(),
      });
      const diagnosticsFilePath = handle.logFilePath;
      try {
        const configReport = runtimeEnvResult?.configMigrationReport;
        if (configReport) {
          emitWithoutAffectingProduct(
            handle.logger,
            runtimeModule.configMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
            migrationCounts(configReport),
          );
        }
        if (migrateOhbabyData !== undefined) {
          const dataReport = await migrateOhbabyData();
          emitWithoutAffectingProduct(
            handle.logger,
            runtimeModule.dataMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
            migrationCounts(dataReport),
          );
        }
        const host = await buildCoreAPIImpl({
          ...agentOptions,
          watchModelConfig: true,
          ...(diagnosticsFilePath === undefined ? {} : { diagnosticsFilePath }),
          logger: handle.logger,
        });
        return {
          ...host,
          reportDurationClockAnomaly: (identity: string): void => {
            emitWithoutAffectingProduct(
              handle.logger,
              runtimeModule.durationClockAnomaly as DiagnosticEventDefinition<{
                readonly identity: string;
              }>,
              { identity },
            );
          },
          ...(diagnosticsFilePath === undefined ? {} : { diagnosticsFilePath }),
          diagnosticsUnavailable: () =>
            diagnosticsUnavailable && !diagnosticsUnavailablePresented,
          subscribeDiagnosticsUnavailable(listener): () => void {
            if (diagnosticsUnavailable) {
              diagnosticsUnavailablePresented = true;
              listener();
              return () => undefined;
            }
            diagnosticsUnavailableListeners.add(listener);
            return (): void => {
              diagnosticsUnavailableListeners.delete(listener);
            };
          },
          async dispose(options?: ShutdownOptions): Promise<void> {
            const sharedOptions =
              options ?? runtimeModule.createShutdownOptions?.();
            if (!sharedOptions || !runtimeModule.collectCleanup)
              throw new Error(
                "Agent runtime is missing shared shutdown support",
              );
            host.closeAdmission?.();
            const result = await runtimeModule.collectCleanup(sharedOptions, {
              host: () => host.dispose(sharedOptions),
            });
            const diagnostics = await runtimeModule.collectCleanup(
              sharedOptions,
              {
                diagnostics: () => handle.dispose(),
              },
            );
            const errors = [...result.errors, ...diagnostics.errors];
            if (errors.length) throw new Error(errors.join("; "));
          },
        };
      } catch (error) {
        await handle.dispose();
        throw error;
      }
    },
    async loadRuntimeEnvIntoProcessEnv(options): Promise<void> {
      runtimeEnvResult = await loadRuntimeEnvIntoProcessEnv(options);
    },
    async listDaemonConnections(): Promise<
      readonly import("./cli/commands/types.js").CliDaemonConnection[]
    > {
      const listDaemonConnections = (await requireServerFunction(
        "listDaemonConnections",
      )) as NonNullable<CliCommandRuntime["listDaemonConnections"]>;
      return listDaemonConnections();
    },
    async readDaemonStatus(): ReturnType<
      CliCommandRuntime["readDaemonStatus"]
    > {
      const readDaemonStatus = (await requireServerFunction(
        "readDaemonStatus",
      )) as CliCommandRuntime["readDaemonStatus"];
      return readDaemonStatus();
    },
    async startDaemonServer(
      options,
    ): ReturnType<CliCommandRuntime["startDaemonServer"]> {
      const startDaemonServer = (await requireServerFunction(
        "startDaemonServer",
      )) as DefaultStartDaemonServer;
      let diagnosticsHandle: ProcessLoggerHandle | undefined;
      return startDaemonServer({
        ...options,
        diagnosticsFactory: async (context: {
          readonly ohbabyHome: string;
          readonly workspaceRoot: string;
        }): Promise<ProcessLoggerHandle | undefined> => {
          const handle = await createProcessLogger({
            ohbabyHome: context.ohbabyHome,
            onUnavailable(): void {
              onServeDiagnosticsUnavailable();
            },
            role: "serve",
            workspaceRoot: context.workspaceRoot,
          });
          if (handle.logFilePath === undefined) {
            return undefined;
          }
          diagnosticsHandle = handle;
          const configReport = runtimeEnvResult?.configMigrationReport;
          if (configReport) {
            emitWithoutAffectingProduct(
              handle.logger,
              runtimeModule.configMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
              migrationCounts(configReport),
            );
          }
          return handle;
        },
        onDataMigrationReport(report: OhbabyMigrationReport): void {
          if (diagnosticsHandle !== undefined) {
            emitWithoutAffectingProduct(
              diagnosticsHandle.logger,
              runtimeModule.dataMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
              migrationCounts(report),
            );
          }
        },
      });
    },
    async stopDaemonFromState(): ReturnType<
      CliCommandRuntime["stopDaemonFromState"]
    > {
      const stopDaemonFromState = (await requireServerFunction(
        "stopDaemonFromState",
      )) as CliCommandRuntime["stopDaemonFromState"];
      return stopDaemonFromState();
    },
  };
}

export async function runOhbabyCli(
  argv: readonly string[] = process.argv,
  io: RunOhbabyCliIo = {},
  dependencies: RunOhbabyCliDependencies = {},
): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const startupNotices = new StartupNoticeBuffer();
  const defaultDependencies =
    dependencies.createCoreHost && dependencies.loadRuntimeEnvIntoProcessEnv
      ? undefined
      : await loadDefaultDependencies(() => {
          stderr.write(
            "Diagnostics file logging became unavailable; the server continued without it.\n",
          );
        });
  const createCoreHost =
    dependencies.createCoreHost ?? defaultDependencies?.createCoreHost;
  const loadRuntimeEnvIntoProcessEnv =
    dependencies.loadRuntimeEnvIntoProcessEnv ??
    defaultDependencies?.loadRuntimeEnvIntoProcessEnv;
  const readDaemonStatus =
    dependencies.readDaemonStatus ??
    defaultDependencies?.readDaemonStatus ??
    ((): ReturnType<CliCommandRuntime["readDaemonStatus"]> =>
      missingRuntimeDependency("readDaemonStatus"));
  const listDaemonConnections =
    dependencies.listDaemonConnections ??
    defaultDependencies?.listDaemonConnections;
  const startDaemonServer =
    dependencies.startDaemonServer ??
    defaultDependencies?.startDaemonServer ??
    ((): ReturnType<CliCommandRuntime["startDaemonServer"]> =>
      missingRuntimeDependency("startDaemonServer"));
  const stopDaemonFromState =
    dependencies.stopDaemonFromState ??
    defaultDependencies?.stopDaemonFromState ??
    ((): ReturnType<CliCommandRuntime["stopDaemonFromState"]> =>
      missingRuntimeDependency("stopDaemonFromState"));
  const openUrl = dependencies.openUrl ?? openUrlWithSystemBrowser;
  const coexistenceNotice =
    dependencies.readServeCoexistenceNotice ??
    defaultDependencies?.readServeCoexistenceNotice;
  const resolveHome =
    dependencies.resolveOhbabyHome ?? defaultDependencies?.resolveOhbabyHome;

  if (!createCoreHost || !loadRuntimeEnvIntoProcessEnv) {
    throw new Error("CLI runtime dependencies were not initialized");
  }

  const proxyOwnership = { server: false };
  let proxyHandle: NetworkProxyHandle | undefined;
  const initializeProxy = async (): Promise<void> => {
    const install =
      dependencies.installSystemProxy ??
      defaultDependencies?.installSystemProxy;
    if (!proxyHandle && install) {
      proxyHandle = await install({
        onStatus: (message) => {
          stderr.write(`${message}\n`);
        },
      });
    }
  };
  const disposeProxy = async (): Promise<void> => {
    const handle = proxyHandle;
    proxyHandle = undefined;
    await handle?.dispose();
  };
  let exitCode: number = EXIT_CODES.ok;
  const runtime: CliCommandRuntime = {
    onHostShutdownComplete: dependencies.onHostShutdownComplete,
    initializeProxy,
    resolveOhbabyDataPaths:
      dependencies.resolveOhbabyDataPaths ??
      defaultDependencies?.resolveOhbabyDataPaths,
    runUpgradePreflight:
      dependencies.runUpgradePreflight ??
      defaultDependencies?.runUpgradePreflight,
    ...(resolveHome === undefined ? {} : { resolveOhbabyHome: resolveHome }),
    ...(resolveHome === undefined
      ? {}
      : {
          startupUpdate: createStartupUpdate({
            resolveOhbabyHome: resolveHome,
            initializeProxy,
            runtime: () => runtime,
            pushStartupNotice: (message) => {
              startupNotices.push(message);
            },
          }),
        }),
    async createCoreHost(options) {
      if (options.remotePort === undefined) await initializeProxy();
      return createRpcCoreHost(await createCoreHost(options));
    },
    createStdoutRenderer(options = {}) {
      return createStdoutRenderer({
        ...options,
        write:
          options.write ??
          ((chunk: string): void => {
            stdout.write(chunk);
          }),
        writeError:
          options.writeError ??
          ((chunk: string): void => {
            stderr.write(chunk);
          }),
      });
    },
    failUsage(message): never {
      throw new CliUsageError(message);
    },
    isStdinTTY() {
      return stdin.isTTY === true;
    },
    listDaemonConnections,
    openUrl,
    readDaemonStatus,
    readStdin() {
      return readStdin(stdin);
    },
    prepareTerminalUi,
    renderTerminalUi,
    setExitCode(code) {
      exitCode = code;
    },
    ...(coexistenceNotice === undefined
      ? {}
      : {
          async showServeCoexistenceNotice(): Promise<void> {
            const notice = await coexistenceNotice();
            if (notice) {
              stderr.write(notice);
            }
          },
        }),
    async startDaemonServer(options) {
      const server = await startDaemonServer({
        ...options,
        beforeBackendStart: async () => {
          await initializeProxy();
        },
        backendCleanup: disposeProxy,
      });
      proxyOwnership.server = !server.reused;
      return server;
    },
    stderr,
    stdout,
    stopDaemonFromState,
    takeStartupNotices: () => startupNotices.takeAll(),
  };

  const presentStartupNotices = (): void => {
    for (const notice of startupNotices.takeAll()) {
      stderr.write(`${notice}\n`);
    }
  };

  try {
    await loadRuntimeEnvIntoProcessEnv({
      onWarning(message: string): void {
        startupNotices.push(message);
      },
    });
    await yargs(hideBin([...argv]))
      .scriptName("ohbaby")
      .option("mode", {
        choices: ["plan", "auto"] as const,
        describe: "set initial permission mode",
        type: "string",
      })
      .option("permission", {
        choices: ["default", "full-access"] as const,
        describe: "set initial permission level",
        type: "string",
      })
      .command(createTerminalCommand(runtime))
      .command(createRunCommand(runtime))
      .command(createServeCommand(runtime))
      .command(createUpdateCommand(runtime, stdin))
      .command(createUninstallCommand(runtime, stdin))
      .demandCommand(0, 1)
      .strict()
      .help()
      .version(VERSION)
      .middleware((args) => {
        if (args._.length > 0) {
          presentStartupNotices();
        }
      }, true)
      .exitProcess(false)
      .fail((message, error) => {
        // Handler failures reach here too; keep structured errors intact.
        if (findDatabaseNewerThanProgram(error)) throw error;
        throw new CliUsageError(message);
      })
      .parseAsync();
    return exitCode;
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`${error.message}\n`);
      return EXIT_CODES.usage;
    }
    const newerDatabase = findDatabaseNewerThanProgram(error);
    if (newerDatabase) {
      stderr.write(`${newerDatabase.message}\n`);
      return EXIT_CODES.failure;
    }
    throw error;
  } finally {
    if (!proxyOwnership.server) await disposeProxy();
    presentStartupNotices();
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  let hostShutdownComplete = false;
  runOhbabyCli(
    process.argv,
    {},
    {
      onHostShutdownComplete: () => {
        hostShutdownComplete = true;
      },
    },
  )
    .then((code) => {
      if (hostShutdownComplete) process.exit(code);
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (hostShutdownComplete) process.exit(EXIT_CODES.failure);
      process.exitCode = EXIT_CODES.failure;
    });
}
