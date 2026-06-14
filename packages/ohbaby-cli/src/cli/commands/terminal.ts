import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

interface TerminalArgs extends CliGlobalOptions {
  readonly continue?: boolean;
  readonly inProcess?: boolean;
  readonly remoteAuthToken?: string;
  readonly remoteHost?: string;
  readonly remotePort?: number;
  readonly resume?: string;
}

function normalizeResumeSessionId(
  resume: TerminalArgs["resume"],
  runtime: CliCommandRuntime,
): string | undefined {
  if (resume === undefined) {
    return undefined;
  }
  const sessionId = resume.trim();
  if (sessionId.length === 0) {
    runtime.failUsage("--resume requires a non-empty session id");
  }
  return sessionId;
}

function normalizeRemotePort(
  remotePort: TerminalArgs["remotePort"],
  runtime: CliCommandRuntime,
): number | undefined {
  if (remotePort === undefined) {
    return undefined;
  }
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65_535) {
    runtime.failUsage("--remote-port must be a TCP port between 1 and 65535");
  }
  return remotePort;
}

function normalizeRemoteHost(remoteHost: TerminalArgs["remoteHost"]): string {
  const host = remoteHost?.trim();
  return host && host.length > 0 ? host : "127.0.0.1";
}

export function createTerminalCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, TerminalArgs> {
  return {
    builder(yargs: Argv<CliGlobalOptions>): Argv<TerminalArgs> {
      return yargs
        .option("continue", {
          describe: "resume the latest primary session before starting the terminal UI",
          type: "boolean",
        })
        .option("resume", {
          describe: "resume a session by id before starting the terminal UI",
          type: "string",
        })
        .option("remote-port", {
          describe: "connect the terminal UI to an explicit daemon port",
          type: "number",
        })
        .option("remote-host", {
          default: "127.0.0.1",
          describe: "connect the terminal UI to an explicit daemon host",
          type: "string",
        })
        .option("remote-auth-token", {
          describe: "bearer token for an explicit remote daemon",
          type: "string",
        })
        .option("in-process", {
          describe: "run the terminal UI against an embedded backend",
          type: "boolean",
        })
        .option("daemon", {
          describe: "run the terminal UI through the local daemon",
          type: "boolean",
        });
    },
    command: "$0",
    describe: "start the interactive terminal UI",
    async handler(args: ArgumentsCamelCase<TerminalArgs>): Promise<void> {
      const resume = normalizeResumeSessionId(args.resume, runtime);
      const remotePort = normalizeRemotePort(args.remotePort, runtime);
      if (resume !== undefined && args.continue === true) {
        runtime.failUsage("--resume and --continue cannot be used together");
      }
      if (
        remotePort !== undefined &&
        (args.inProcess === true || args.daemon === false)
      ) {
        runtime.failUsage("--remote-port cannot be used with --in-process");
      }
      const useInProcess = args.inProcess === true || args.daemon === false;
      const host = await runtime.createCoreHost({
        ...(args.continue === true ? { continue: true } : {}),
        ...(remotePort === undefined
          ? useInProcess
            ? { daemon: false, inProcess: true }
            : { daemon: true }
          : {}),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.permission === undefined ? {} : { permission: args.permission }),
        ...(remotePort === undefined
          ? {}
          : {
              ...(args.remoteAuthToken === undefined
                ? {}
                : { remoteAuthToken: args.remoteAuthToken }),
              remoteHost: normalizeRemoteHost(args.remoteHost),
              remotePort,
            }),
        ...(resume === undefined ? {} : { resume }),
      });
      try {
        if (resume !== undefined || args.continue === true) {
          await host.core.getSnapshot();
        }
        const instance = runtime.renderTerminalUi({
          clearOnStart: resume === undefined && args.continue !== true,
          client: host.core,
          subscribeEvents: (handler) => host.callbacks.subscribeEvents(handler),
        });
        await instance.waitUntilExit?.();
      } finally {
        await host.dispose();
      }
    },
  };
}
