import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Chalk } from "chalk";
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
  describeUninstallStep,
  planUninstall,
  type UninstallStep,
} from "../../install/uninstall-plan.js";
import type {
  CliCommandRuntime,
  CliGlobalOptions,
  CliWritable,
} from "./types.js";

interface UninstallArgs extends CliGlobalOptions {
  readonly yes?: boolean;
}

async function executeUninstallStep(
  action: UninstallStep,
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
  }
}

// The running command still uses the Node runtime inside the installation
// directory on Windows, so the user deletes it after this process exits.
function writeWindowsDeleteCommands(path: string, stdout: CliWritable): void {
  const literal = path.replaceAll("'", "''");
  stdout.write(
    `PowerShell: Remove-Item -LiteralPath '${literal}' -Recurse -Force\n`,
  );
  // cmd expands these characters even inside double quotes.
  if (!/[%!]/.test(path)) stdout.write(`cmd: rmdir /s /q "${path}"\n`);
}

// Same gold as the installer's step numbers: truecolor when the terminal
// says so, otherwise the nearest basic colour.
function stepNumberColor(runtime: CliCommandRuntime): (text: string) => string {
  const env = process.env;
  const enabled = runtime.isStdoutTTY() && !env.NO_COLOR && env.TERM !== "dumb";
  const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
  return new Chalk({ level: enabled ? (truecolor ? 3 : 1) : 0 }).hex("#D4A24F");
}

async function runUninstallSteps(
  steps: readonly UninstallStep[],
  installDir: string | undefined,
  userHome: string,
  runtime: CliCommandRuntime,
): Promise<void> {
  const texts = steps.map((step) =>
    describeUninstallStep(step, process.platform, userHome),
  );
  const width = Math.max(0, ...texts.map((text) => text.length));
  const number = stepNumberColor(runtime);
  for (const [index, step] of steps.entries()) {
    const label = number(`[${String(index + 1)}/${String(steps.length)}]`);
    // npm prints its own progress and result, so its line stands alone.
    if (step.kind === "npm") {
      runtime.stdout.write(`${label} ${texts[index]}\n`);
      await executeUninstallStep(step, installDir, runtime);
      continue;
    }
    runtime.stdout.write(`${label} ${texts[index].padEnd(width)}`);
    try {
      await executeUninstallStep(step, installDir, runtime);
    } catch (error) {
      runtime.stdout.write("  failed\n");
      throw error;
    }
    runtime.stdout.write("  done\n");
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
          await runUninstallSteps(
            actions.filter((action) => action.kind !== "windows-manual"),
            installDir,
            userHome,
            runtime,
          );
        } finally {
          await release?.();
        }
        const manual = actions.find(
          (action) => action.kind === "windows-manual",
        );
        if (manual) {
          runtime.stdout.write(
            "\nohbaby is removed from your PATH. To finish, delete the installation directory after this command exits:\n",
          );
          writeWindowsDeleteCommands(manual.path, runtime.stdout);
        } else {
          runtime.stdout.write("\nohbaby is uninstalled.\n");
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
