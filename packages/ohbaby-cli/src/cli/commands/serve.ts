import type { CommandModule } from "yargs";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

export function createServeCommand(
  runtime: CliCommandRuntime,
): CommandModule<CliGlobalOptions, Record<string, never>> {
  return {
    command: "serve",
    describe: "start the daemon for remote frontends",
    handler(): void {
      runtime.stderr.write("serve mode is not yet implemented\n");
      runtime.setExitCode(1);
    },
  };
}
