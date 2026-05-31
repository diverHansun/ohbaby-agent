import type { ArgumentsCamelCase, CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

export function createTerminalCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, CliGlobalOptions> {
  return {
    command: "$0",
    describe: "start the interactive terminal UI",
    async handler(args: ArgumentsCamelCase<CliGlobalOptions>): Promise<void> {
      const host = runtime.createCoreHost({
        mode: args.mode,
        permission: args.permission,
      });
      try {
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
