import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Argv, CommandModule } from "yargs";
import {
  npmCommand,
  runInstallerCommand,
} from "../../install/child-command.js";
import { readConfirmation } from "../../install/confirm.js";
import { detectInstallMethod } from "../../install/install-method.js";
import {
  acquireUninstallLock,
  removeOwnedLauncher,
  removeShellPathBlock,
  removeWindowsUserPath,
  validateUninstallDirectory,
} from "../../install/script-uninstall.js";
import {
  describeUninstallAction,
  planUninstall,
  type UninstallAction,
} from "../../install/uninstall-plan.js";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

interface UninstallArgs extends CliGlobalOptions {
  readonly yes?: boolean;
}

async function executeUninstallAction(
  action: UninstallAction,
  installDir: string | undefined,
  runtime: CliCommandRuntime,
): Promise<void> {
  switch (action.kind) {
    case "npm": {
      const { status } = await runInstallerCommand(npmCommand(action.prefix), [
        "uninstall",
        "-g",
        "--prefix",
        action.prefix,
        "ohbaby-cli",
      ]);
      if (status !== "0") throw new Error(`npm uninstall failed (${status}).`);
      if (process.platform === "win32") {
        runtime.stderr.write(
          'After a successful uninstall, you can ignore a "The batch file cannot be found" message.\n',
        );
      }
      break;
    }
    case "shell-config":
    case "fish-config":
      await removeShellPathBlock(action.path, action.kind === "fish-config");
      break;
    case "launcher":
      if (installDir) await removeOwnedLauncher(action.path, installDir);
      break;
    case "directory":
      await rm(action.path, { recursive: true, force: true });
      break;
    case "windows-path":
      await removeWindowsUserPath(action.path);
      break;
    case "windows-manual": {
      const literal = action.path.replaceAll("'", "''");
      runtime.stdout.write(
        "After this command exits, make sure no installation is running. Then delete the installation directory using your shell.\n" +
          `PowerShell: Remove-Item -LiteralPath '${literal}' -Recurse -Force\n`,
      );
      // cmd expands these characters even inside double quotes.
      if (!/[%!]/.test(action.path)) {
        runtime.stdout.write(`cmd: rmdir /s /q "${action.path}"\n`);
      }
      break;
    }
  }
}

export function createUninstallCommand(
  runtime: CliCommandRuntime,
  stdin: Readable,
): CommandModule<CliGlobalOptions, UninstallArgs> {
  return {
    command: "uninstall",
    describe: "uninstall ohbaby and keep your data",
    builder(yargs: Argv<CliGlobalOptions>): Argv<UninstallArgs> {
      return yargs.option("yes", {
        alias: "y",
        type: "boolean",
        describe: "skip confirmation",
      });
    },
    async handler(args) {
      try {
        const method = detectInstallMethod();
        if (method.kind === "other") {
          runtime.stderr.write(
            "Could not identify how ohbaby was installed. Use your original package manager to uninstall it. For npm: npm uninstall -g ohbaby-cli.\n",
          );
          runtime.setExitCode(1);
          return;
        }
        if (
          !runtime.resolveOhbabyHome ||
          !runtime.resolveOhbabyDataPaths ||
          !runtime.runUpgradePreflight
        ) {
          throw new Error("The install safety check is unavailable.");
        }
        const userHome = homedir();
        const ohbabyHome = runtime.resolveOhbabyHome();
        const { dataRoot, databasePath } = runtime.resolveOhbabyDataPaths();
        const installDir =
          method.kind === "script" ? method.installDir : undefined;
        const protectedPaths = [userHome, ohbabyHome, dataRoot, databasePath];
        if (installDir)
          await validateUninstallDirectory(installDir, protectedPaths);

        const actions = planUninstall(method, process.platform, userHome);
        for (const action of actions)
          runtime.stdout.write(`${describeUninstallAction(action)}\n`);
        if (!args.yes) {
          if (!runtime.isStdinTTY())
            throw new Error(
              "Pass -y to uninstall in a non-interactive terminal.",
            );
          runtime.stderr.write("Uninstall ohbaby? [y/N] ");
          if (!["y", "yes"].includes((await readConfirmation(stdin)) ?? "n"))
            return;
        }

        const release = installDir
          ? await acquireUninstallLock(installDir)
          : undefined;
        try {
          if (installDir)
            await validateUninstallDirectory(installDir, protectedPaths);
          const preflight = await runtime.runUpgradePreflight({
            installMethod: method,
          });
          if (!preflight.ok) throw new Error(preflight.reasons.join("\n"));
          for (const action of actions)
            await executeUninstallAction(action, installDir, runtime);
        } finally {
          await release?.();
        }
        runtime.stdout.write(
          `Kept your configuration at ${ohbabyHome}, sessions at ${join(ohbabyHome, "sessions")}, and database at ${databasePath}.\n`,
        );
      } catch (error) {
        runtime.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        runtime.setExitCode(1);
      }
    },
  };
}
