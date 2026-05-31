import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

interface RunArgs extends CliGlobalOptions {
  readonly prompt?: readonly string[] | string;
}

function promptFromArgs(prompt: RunArgs["prompt"]): string | undefined {
  return typeof prompt === "string" ? prompt : prompt?.join(" ");
}

async function resolvePrompt(
  args: ArgumentsCamelCase<RunArgs>,
  runtime: CliCommandRuntime,
): Promise<string> {
  const prompt = promptFromArgs(args.prompt)?.trim();
  if (prompt !== undefined) {
    if (prompt.length === 0) {
      runtime.failUsage("run requires a non-empty prompt or piped stdin");
    }
    return prompt;
  }

  if (runtime.isStdinTTY()) {
    runtime.failUsage("run requires a prompt or piped stdin");
  }

  const pipedPrompt = (await runtime.readStdin()).trim();
  if (pipedPrompt.length === 0) {
    runtime.failUsage("run requires a non-empty prompt or piped stdin");
  }
  return pipedPrompt;
}

export function createRunCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, RunArgs> {
  return {
    builder(yargs: Argv<CliGlobalOptions>): Argv<RunArgs> {
      return yargs.positional("prompt", {
        array: true,
        describe: "prompt text to send",
        type: "string",
      });
    },
    command: "run [prompt..]",
    describe: "run a prompt in non-interactive mode",
    async handler(args: ArgumentsCamelCase<RunArgs>): Promise<void> {
      const prompt = await resolvePrompt(args, runtime);
      const host = runtime.createCoreHost({
        mode: args.mode,
        permission: args.permission,
      });
      const renderer = runtime.createStdoutRenderer();
      const unsubscribe = host.callbacks.subscribeEvents((event) => {
        renderer.handle(event);
      });

      try {
        await host.core.submitPrompt(prompt);
      } finally {
        unsubscribe();
        await host.dispose();
      }
    },
  };
}
