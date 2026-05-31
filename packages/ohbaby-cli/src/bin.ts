#!/usr/bin/env node
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { CoreAPI } from "ohbaby-sdk";
import { createRPC } from "ohbaby-sdk";
import { buildCoreAPIImpl, loadRuntimeEnvIntoProcessEnv } from "ohbaby-agent";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { createRunCommand } from "./cli/commands/run.js";
import { createServeCommand } from "./cli/commands/serve.js";
import { createTerminalCommand } from "./cli/commands/terminal.js";
import type {
  CliCommandRuntime,
  CliCoreHost,
  CliGlobalOptions,
  CliWritable,
} from "./cli/commands/types.js";
import { EXIT_CODES } from "./cli/exit-codes.js";
import { readStdin } from "./cli/stdin.js";
import { createStdoutRenderer } from "./cli/stdout-renderer.js";
import { renderTerminalUi } from "./tui/index.js";

const VERSION = "0.1.0";

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

function createCoreHost(options: CliGlobalOptions): CliCoreHost {
  const host = buildCoreAPIImpl(options);
  const rpc = createRPC<CoreAPI>();
  rpc.connectImpl(host.core);
  return {
    callbacks: host.callbacks,
    core: rpc.createProxy(host.callbacks),
    dispose: host.dispose,
  };
}

export async function runOhbabyCli(
  argv: readonly string[] = process.argv,
  io: RunOhbabyCliIo = {},
): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  let exitCode: number = EXIT_CODES.ok;
  const runtime: CliCommandRuntime = {
    createCoreHost,
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
    readStdin() {
      return readStdin(stdin);
    },
    renderTerminalUi,
    setExitCode(code) {
      exitCode = code;
    },
    stderr,
  };

  try {
    await loadRuntimeEnvIntoProcessEnv();
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
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
