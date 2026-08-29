#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoreAPI } from "ohbaby-sdk";
import { createRPC } from "ohbaby-sdk";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { createRunCommand } from "./cli/commands/run.js";
import { createServeCommand } from "./cli/commands/serve.js";
import { createTerminalCommand } from "./cli/commands/terminal.js";
import type {
  CliCommandRuntime,
  CliCoreHost,
  CliCoreHostResult,
  CliGlobalOptions,
  CliWritable,
} from "./cli/commands/types.js";
import { EXIT_CODES } from "./cli/exit-codes.js";
import { readStdin } from "./cli/stdin.js";
import { createStdoutRenderer } from "./cli/stdout-renderer.js";
import { getCliPackageVersion } from "./package-version.js";
import { readServeCoexistenceNotice } from "./serve-awareness.js";
import { renderTerminalUi } from "./tui/index.js";
import type {
  DiagnosticEventDefinition,
  LoadRuntimeEnvOptions,
  LoadRuntimeEnvResult,
  Logger,
  OhbabyMigrationReport,
  ProcessLoggerHandle,
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

export interface RunOhbabyCliIo {
  readonly stderr?: CliWritable;
  readonly stdin?: Readable & { readonly isTTY?: boolean };
  readonly stdout?: CliWritable;
}

export interface RunOhbabyCliDependencies {
  readonly createCoreHost?: (options: CliGlobalOptions) => CliCoreHostResult;
  readonly listDaemonConnections?: NonNullable<
    CliCommandRuntime["listDaemonConnections"]
  >;
  readonly loadRuntimeEnvIntoProcessEnv?: (
    options?: LoadRuntimeEnvOptions,
  ) => Promise<void> | void;
  readonly openUrl?: CliCommandRuntime["openUrl"];
  readonly readServeCoexistenceNotice?: () => Promise<string | undefined>;
  readonly readDaemonStatus?: CliCommandRuntime["readDaemonStatus"];
  readonly startDaemonServer?: CliCommandRuntime["startDaemonServer"];
  readonly stopDaemonFromState?: CliCommandRuntime["stopDaemonFromState"];
}

interface DaemonStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" | "fresh" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: "default" | "full-access";
    readonly mode: "plan" | "auto";
  };
}

interface RemoteDaemonClientOptions {
  readonly authToken?: string;
  readonly directory?: string;
  readonly host?: string;
  readonly port: number;
  readonly startupIntent?: DaemonStartupIntent;
}

interface AgentRuntimeModule {
  readonly buildCoreAPIImpl?: unknown;
  readonly configMigrationCompleted?: unknown;
  readonly createProcessLogger?: unknown;
  readonly dataMigrationCompleted?: unknown;
  readonly loadRuntimeEnvIntoProcessEnv?: unknown;
  readonly migrateOhbabyData?: unknown;
}

type AgentCoreFactoryOptions = CliGlobalOptions & {
  readonly diagnosticsFilePath?: string;
  readonly logger?: Logger;
};

type DefaultStartDaemonServerOptions = Parameters<
  NonNullable<CliCommandRuntime["startDaemonServer"]>
>[0] & {
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

interface ServerRuntimeModule {
  readonly createRemoteCoreApiHost?: unknown;
  readonly listDaemonConnections?: unknown;
  readonly readDaemonStatus?: unknown;
  readonly startDaemonServer?: unknown;
  readonly stopDaemonFromState?: unknown;
}

function createRpcCoreHost(host: CliCoreHost): CliCoreHost {
  const rpc = createRPC<CoreAPI>();
  rpc.connectImpl(host.core);
  return {
    callbacks: host.callbacks,
    core: rpc.createProxy(host.callbacks),
    dispose: host.dispose,
    ...(host.diagnosticsFilePath === undefined
      ? {}
      : { diagnosticsFilePath: host.diagnosticsFilePath }),
    ...(host.diagnosticsUnavailable === undefined
      ? {}
      : { diagnosticsUnavailable: host.diagnosticsUnavailable }),
  };
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
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

function optionalRuntimeExport(
  runtimeModule: Record<string, unknown>,
  name: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(runtimeModule, name)
    ? runtimeModule[name]
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

  return {
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
      const diagnosticsUnavailableListeners = new Set<() => void>();
      const handle = await createProcessLogger({
        onUnavailable(): void {
          if (diagnosticsUnavailable) {
            return;
          }
          diagnosticsUnavailable = true;
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
          handle.logger.emit(
            runtimeModule.configMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
            migrationCounts(configReport),
          );
        }
        if (migrateOhbabyData !== undefined) {
          const dataReport = await migrateOhbabyData();
          handle.logger.emit(
            runtimeModule.dataMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
            migrationCounts(dataReport),
          );
        }
        const host = await buildCoreAPIImpl({
          ...agentOptions,
          ...(diagnosticsFilePath === undefined ? {} : { diagnosticsFilePath }),
          logger: handle.logger,
        });
        return {
          ...host,
          ...(diagnosticsFilePath === undefined ? {} : { diagnosticsFilePath }),
          diagnosticsUnavailable: () => diagnosticsUnavailable,
          subscribeDiagnosticsUnavailable(listener): () => void {
            if (diagnosticsUnavailable) {
              listener();
              return () => undefined;
            }
            diagnosticsUnavailableListeners.add(listener);
            return (): void => {
              diagnosticsUnavailableListeners.delete(listener);
            };
          },
          async dispose(): Promise<void> {
            try {
              await host.dispose();
            } finally {
              await handle.dispose();
            }
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
            handle.logger.emit(
              runtimeModule.configMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
              migrationCounts(configReport),
            );
          }
          return handle;
        },
        onDataMigrationReport(report: OhbabyMigrationReport): void {
          diagnosticsHandle?.logger.emit(
            runtimeModule.dataMigrationCompleted as DiagnosticEventDefinition<MigrationCounts>,
            migrationCounts(report),
          );
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
    (defaultDependencies === undefined
      ? undefined
      : (): Promise<string | undefined> =>
          readServeCoexistenceNotice({ packageVersion: VERSION }));

  if (!createCoreHost || !loadRuntimeEnvIntoProcessEnv) {
    throw new Error("CLI runtime dependencies were not initialized");
  }

  let exitCode: number = EXIT_CODES.ok;
  const runtime: CliCommandRuntime = {
    async createCoreHost(options) {
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
    startDaemonServer,
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
      .fail((message) => {
        throw new CliUsageError(message);
      })
      .parseAsync();
    return exitCode;
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`${error.message}\n`);
      return EXIT_CODES.usage;
    }
    throw error;
  } finally {
    presentStartupNotices();
  }
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  runOhbabyCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = EXIT_CODES.failure;
    });
}
