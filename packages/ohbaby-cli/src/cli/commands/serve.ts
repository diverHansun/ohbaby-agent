import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHost } from "ohbaby-sdk";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

type ServeAction = "ps" | "start" | "status" | "stop";

interface ServeArgs extends CliGlobalOptions {
  readonly action?: ServeAction;
  readonly authToken?: string;
  readonly dbPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly webAssetsDir?: string;
}

export function resolveBundledWebAssetsDir(
  moduleUrl = import.meta.url,
): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const pathParts = moduleDir.split(sep);
  const distIndex = pathParts.lastIndexOf("dist");
  if (distIndex >= 0) {
    return resolve(pathParts.slice(0, distIndex + 1).join(sep), "web");
  }
  return resolve(moduleDir, "../../..", "dist", "web");
}

const BUNDLED_WEB_ASSETS_DIR = resolveBundledWebAssetsDir();

function normalizePort(
  port: ServeArgs["port"],
  runtime: CliCommandRuntime,
): number | undefined {
  if (port === undefined) {
    return undefined;
  }
  const value = port;
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    runtime.failUsage("--port must be a TCP port between 0 and 65535");
  }
  return value;
}

function normalizeHost(host: ServeArgs["host"]): string {
  const value = host?.trim();
  return value && value.length > 0 ? value : "127.0.0.1";
}

function defaultWebAssetsDirForHost(host: string): string | undefined {
  return isLoopbackHost(host) ? BUNDLED_WEB_ASSETS_DIR : undefined;
}

function formatStatus(
  state: Awaited<ReturnType<CliCommandRuntime["readDaemonStatus"]>>,
): string {
  if (!state) {
    return "daemon status: not-running\n";
  }
  const pid = state.pid === undefined ? "" : ` pid=${String(state.pid)}`;
  const url =
    state.host === undefined || state.port === undefined
      ? ""
      : ` url=http://${state.host}:${String(state.port)}`;
  const version =
    state.packageVersion === undefined
      ? ""
      : ` version=${state.packageVersion}`;
  return `daemon status: ${state.status}${pid}${url}${version} updatedAt=${String(
    state.updatedAt,
  )}\n`;
}

function formatConnections(
  connections: Awaited<
    ReturnType<NonNullable<CliCommandRuntime["listDaemonConnections"]>>
  >,
): string {
  if (connections.length === 0) {
    return "daemon connections: none\n";
  }
  return connections
    .map(
      (connection) =>
        `client=${connection.clientId} scope=${connection.scopeKey} connectedAt=${String(connection.connectedAt)}\n`,
    )
    .join("");
}

export function createServeCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, ServeArgs> {
  return {
    builder(yargs: Argv<CliGlobalOptions>): Argv<ServeArgs> {
      return yargs
        .positional("action", {
          choices: ["ps", "start", "status", "stop"] as const,
          default: "start" as const,
          describe: "daemon action",
          type: "string",
        })
        .option("port", {
          describe: "daemon HTTP port",
          type: "number",
        })
        .option("host", {
          default: "127.0.0.1",
          describe: "daemon HTTP host",
          type: "string",
        })
        .option("db-path", {
          describe: "daemon database path",
          type: "string",
        })
        .option("auth-token", {
          describe: "bearer token required by explicit daemon clients",
          type: "string",
        })
        .option("web-assets-dir", {
          describe:
            "serve a built ohbaby-web dist directory at the daemon root",
          type: "string",
        });
    },
    command: "serve [action]",
    describe: "start the daemon for remote frontends",
    async handler(args: ArgumentsCamelCase<ServeArgs>): Promise<void> {
      const action = args.action ?? "start";
      if (action === "status") {
        runtime.stdout.write(formatStatus(await runtime.readDaemonStatus()));
        return;
      }
      if (action === "ps") {
        if (!runtime.listDaemonConnections) {
          throw new Error("Daemon connection inspection is unavailable");
        }
        runtime.stdout.write(
          formatConnections(await runtime.listDaemonConnections()),
        );
        return;
      }
      if (action === "stop") {
        runtime.stdout.write(`daemon ${await runtime.stopDaemonFromState()}\n`);
        return;
      }

      const host = normalizeHost(args.host);
      if (args.webAssetsDir !== undefined && !isLoopbackHost(host)) {
        runtime.failUsage(
          "--web-assets-dir can only be used with a loopback --host",
        );
      }

      const port = normalizePort(args.port, runtime);
      const webAssetsDir =
        args.webAssetsDir ?? defaultWebAssetsDirForHost(host);
      const server = await runtime.startDaemonServer({
        ...(args.authToken === undefined ? {} : { authToken: args.authToken }),
        ...(args.dbPath === undefined ? {} : { dbPath: args.dbPath }),
        ...(webAssetsDir === undefined ? {} : { webAssetsDir }),
        host,
        ...(port === undefined ? {} : { port }),
      });
      runtime.stdout.write(`ohbaby web ready: ${server.url}\n`);
      try {
        await runtime.openUrl(server.url);
      } catch {
        runtime.stderr.write(
          `Could not open browser automatically. Open ${server.url} manually.\n`,
        );
      }
    },
  };
}
