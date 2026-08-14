import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import type { UiPromptCompletion } from "ohbaby-sdk";
import { EXIT_CODES } from "../exit-codes.js";
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

function applyCompletionExitPolicy(
  completion: UiPromptCompletion,
  runtime: CliCommandRuntime,
): void {
  const prompt = completion.prompt;
  switch (prompt.status) {
    case "succeeded":
      return;
    case "cancelled":
      runtime.stderr.write("prompt cancelled\n");
      runtime.setExitCode(EXIT_CODES.failure);
      return;
    case "failed":
      runtime.stderr.write(`${prompt.error.code}: ${prompt.error.message}\n`);
      runtime.setExitCode(EXIT_CODES.failure);
      return;
    case "interrupted":
      runtime.stderr.write(`${prompt.error.code}: ${prompt.error.message}\n`);
      runtime.setExitCode(EXIT_CODES.interrupted);
  }
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
      const host = await runtime.createCoreHost({
        inProcess: true,
        mode: args.mode,
        permission: args.permission,
      });
      const renderer = runtime.createStdoutRenderer();
      const unsubscribe = host.callbacks.subscribeEvents((event) => {
        renderer.handle(event);
      });

      try {
        const completion = await host.core.submitPromptAndWait(prompt);
        applyCompletionExitPolicy(completion, runtime);
      } finally {
        unsubscribe();
        await host.dispose();
      }
    },
  };
}
