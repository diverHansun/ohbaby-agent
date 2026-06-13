import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

type ServeAction = "start" | "status" | "stop";

interface ServeArgs extends CliGlobalOptions {
  readonly action?: ServeAction;
  readonly authToken?: string;
  readonly dbPath?: string;
  readonly host?: string;
  readonly port?: number;
}

function normalizePort(
  port: ServeArgs["port"],
  runtime: CliCommandRuntime,
): number {
  const value = port ?? 4096;
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    runtime.failUsage("--port must be a TCP port between 1 and 65535");
  }
  return value;
}

function normalizeHost(host: ServeArgs["host"]): string {
  const value = host?.trim();
  return value && value.length > 0 ? value : "127.0.0.1";
}

function formatStatus(
  state: Awaited<ReturnType<CliCommandRuntime["readDaemonStatus"]>>,
): string {
  if (!state) {
    return "daemon status: not-running\n";
  }
  const pid = state.pid === undefined ? "" : ` pid=${String(state.pid)}`;
  return `daemon status: ${state.status}${pid} updatedAt=${String(
    state.updatedAt,
  )}\n`;
}

export function createServeCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, ServeArgs> {
  return {
    builder(yargs: Argv<CliGlobalOptions>): Argv<ServeArgs> {
      return yargs
        .positional("action", {
          choices: ["start", "status", "stop"] as const,
          default: "start" as const,
          describe: "daemon action",
          type: "string",
        })
        .option("port", {
          default: 4096,
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
      if (action === "stop") {
        runtime.stdout.write(`daemon ${await runtime.stopDaemonFromState()}\n`);
        return;
      }

      const server = await runtime.startDaemonServer({
        ...(args.authToken === undefined ? {} : { authToken: args.authToken }),
        ...(args.dbPath === undefined ? {} : { dbPath: args.dbPath }),
        host: normalizeHost(args.host),
        port: normalizePort(args.port, runtime),
      });
      runtime.stdout.write(`daemon listening on ${server.url}\n`);
    },
  };
}
