import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

interface TerminalArgs extends CliGlobalOptions {
  readonly continue?: boolean;
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
        });
    },
    command: "$0",
    describe: "start the interactive terminal UI",
    async handler(args: ArgumentsCamelCase<TerminalArgs>): Promise<void> {
      const resume = normalizeResumeSessionId(args.resume, runtime);
      if (resume !== undefined && args.continue === true) {
        runtime.failUsage("--resume and --continue cannot be used together");
      }
      const host = runtime.createCoreHost({
        ...(args.continue === true ? { continue: true } : {}),
        mode: args.mode,
        permission: args.permission,
        ...(resume === undefined ? {} : { resume }),
      });
      try {
        if (resume !== undefined || args.continue === true) {
          await host.core.getSnapshot();
        }
        const instance = runtime.renderTerminalUi({
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
