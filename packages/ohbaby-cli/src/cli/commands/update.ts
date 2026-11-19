import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Argv, CommandModule } from "yargs";
import {
  installedCliCommand,
  npmCommand,
  runInstallerCommand,
} from "../../install/child-command.js";
import { readConfirmation } from "../../install/confirm.js";
import {
  detectInstallMethod,
  type ManagedInstallMethod,
} from "../../install/install-method.js";
import { readSingleLine } from "../../install/text-file.js";
import { getCliPackageVersion } from "../../package-version.js";
import { setAutoUpdate } from "../../update/settings.js";
import {
  fetchLatestVersion,
  isExactVersion,
  writeVersionCache,
} from "../../update/version-check.js";
import type { CliCommandRuntime, CliGlobalOptions } from "./types.js";

interface UpdateArgs extends CliGlobalOptions {
  readonly auto?: "on" | "off" | readonly ("on" | "off")[];
  readonly targetVersion?: string;
  readonly yes?: boolean;
}

interface UpdateRequest {
  readonly ohbabyHome: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly runtime: CliCommandRuntime;
}

type InstallResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly filesMayHaveChanged: boolean;
      readonly message: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installFailure(
  message: string,
  filesMayHaveChanged = false,
): InstallResult {
  return { ok: false, message, filesMayHaveChanged };
}

async function prepareScript(
  version: string,
  destination: string,
): Promise<void> {
  const extension = process.platform === "win32" ? "ps1" : "sh";
  const url = `https://cdn.jsdelivr.net/npm/ohbaby-cli@${version}/install.${extension}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok)
    throw new Error(`HTTP ${String(response.status)} from ${url}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()), {
    flag: "wx",
    mode: 0o600,
  });
}

async function installWithScript(
  installDir: string,
  script: string,
  currentVersion: string,
  targetVersion: string,
): Promise<InstallResult> {
  const windows = process.platform === "win32";
  let status: string;
  try {
    ({ status } = await runInstallerCommand(
      windows ? "powershell.exe" : "sh",
      windows
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
        : [script],
      {
        env: {
          ...process.env,
          OHBABY_INSTALL_VERSION: targetVersion,
          OHBABY_INSTALL_DIR: installDir,
          OHBABY_NON_INTERACTIVE: "1",
        },
      },
    ));
  } catch (error) {
    status = errorMessage(error);
  }

  let activeVersion: string | undefined;
  try {
    const active = readSingleLine(join(installDir, "current"));
    if (isExactVersion(active)) activeVersion = active;
  } catch {
    // A missing or invalid pointer cannot prove the previous version is intact.
  }

  if (activeVersion === targetVersion) {
    return status === "0"
      ? { ok: true }
      : installFailure(
          `Switched to ohbaby ${targetVersion}, but the installer reported an error (${status}). Open a new terminal. To complete setup, rerun the installer for ${targetVersion}.`,
          true,
        );
  }
  const details = `Installer result: ${status}. Expected active version ${targetVersion}.`;
  if (activeVersion === currentVersion) {
    return installFailure(
      `${details} The current version is still ${currentVersion}.`,
    );
  }
  return installFailure(
    `${details} Active version: ${activeVersion ?? "unknown"}. Rerun the installer for ${targetVersion} to repair the installation.`,
    true,
  );
}

async function installWithNpm(
  prefix: string,
  targetVersion: string,
): Promise<InstallResult> {
  let result: Awaited<ReturnType<typeof runInstallerCommand>>;
  try {
    result = await runInstallerCommand(npmCommand(prefix), [
      "install",
      "-g",
      "--prefix",
      prefix,
      `ohbaby-cli@${targetVersion}`,
    ]);
  } catch (error) {
    return installFailure(`Could not start npm: ${errorMessage(error)}`);
  }

  const repair = `Repair this installation with npm install -g --prefix "${prefix}" ohbaby-cli@${targetVersion}.`;
  if (result.status !== "0") {
    return installFailure(
      `npm install failed (${result.status}). ${repair}`,
      true,
    );
  }
  try {
    const verified = await runInstallerCommand(
      installedCliCommand(prefix),
      ["--version"],
      { capture: true },
    );
    if (verified.status === "0" && verified.output === targetVersion) {
      return { ok: true };
    }
    return installFailure(
      `Version verification failed (${verified.status}): expected ${targetVersion}, got ${verified.output || "no version"}. ${repair}`,
      true,
    );
  } catch (error) {
    return installFailure(
      `Version verification failed: ${errorMessage(error)}. ${repair}`,
      true,
    );
  }
}

async function performUpdate(
  { ohbabyHome, currentVersion, targetVersion, runtime }: UpdateRequest,
  method: ManagedInstallMethod,
  automatic: boolean,
): Promise<InstallResult> {
  let temp: string | undefined;
  let install: () => Promise<InstallResult>;
  try {
    if (method.kind === "npm") {
      const modules =
        process.platform === "win32" ? "node_modules" : "lib/node_modules";
      try {
        await access(join(method.prefix, modules), constants.W_OK);
      } catch {
        return installFailure(
          `Cannot write to the npm installation at ${method.prefix}. Use the permissions or package manager you used to install ohbaby.`,
        );
      }
      install = () => installWithNpm(method.prefix, targetVersion);
    } else {
      if (!/^[0-9A-Za-z.-]+$/.test(targetVersion)) {
        return installFailure(
          "Script installations require a version without build metadata.",
        );
      }
      try {
        temp = await mkdtemp(join(tmpdir(), "ohbaby-update-"));
        const script = join(
          temp,
          process.platform === "win32" ? "install.ps1" : "install.sh",
        );
        await prepareScript(targetVersion, script);
        install = () =>
          installWithScript(
            method.installDir,
            script,
            currentVersion,
            targetVersion,
          );
      } catch (error) {
        return installFailure(
          `Could not download the installer for ${targetVersion}: ${errorMessage(error)}`,
        );
      }
    }

    if (!runtime.runUpgradePreflight)
      return installFailure("The install safety check is unavailable.");
    let preflight: Awaited<
      ReturnType<NonNullable<CliCommandRuntime["runUpgradePreflight"]>>
    >;
    try {
      preflight = await runtime.runUpgradePreflight({
        installMethod: method,
        env: { ...process.env, OHBABY_HOME: ohbabyHome },
      });
    } catch (error) {
      return installFailure(
        `Could not check the installation: ${errorMessage(error)}`,
      );
    }
    if (!preflight.ok) return installFailure(preflight.reasons.join("\n"));
    const result = await install();

    if (preflight.stoppedDaemon) {
      runtime.stderr.write(
        "The daemon stopped. Run ohbaby serve when you are ready to start it again.\n",
      );
    }
    if (result.ok) {
      runtime.stdout.write(
        automatic
          ? `Automatically updated ohbaby to ${targetVersion}. Run ohbaby again to start the new version.\n`
          : `Updated ohbaby to ${targetVersion}.\n`,
      );
      if (process.platform === "win32" && method.kind === "npm") {
        runtime.stderr.write(
          'After a successful update, you can ignore a "The batch file cannot be found" message.\n',
        );
      }
    }
    return result;
  } finally {
    if (temp)
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

const unsupportedInstall =
  "Could not identify how ohbaby was installed. Use your original package manager to update it. For npm: npm install -g ohbaby-cli@latest.";

export async function runAutomaticUpdate(
  request: UpdateRequest,
): Promise<"continue" | "exit"> {
  const { runtime, targetVersion } = request;
  const method = detectInstallMethod();
  if (method.kind === "other") {
    runtime.stderr.write(`${unsupportedInstall}\n`);
    return "continue";
  }
  runtime.stderr.write(
    `Checking if ohbaby can automatically update to ${targetVersion}.\n`,
  );
  const result = await performUpdate(request, method, true);
  if (result.ok) {
    runtime.setExitCode(0);
    return "exit";
  }
  runtime.stderr.write(`${result.message}\n`);
  if (!result.filesMayHaveChanged) return "continue";
  runtime.stderr.write(
    "Run ohbaby update --auto off to turn off automatic updates before restarting.\n",
  );
  runtime.setExitCode(1);
  return "exit";
}

export function createUpdateCommand(
  runtime: CliCommandRuntime,
  stdin: Readable,
): CommandModule<CliGlobalOptions, UpdateArgs> {
  return {
    command: "update [targetVersion]",
    describe: "update the ohbaby CLI and bundled Web UI",
    builder(yargs: Argv<CliGlobalOptions>): Argv<UpdateArgs> {
      return yargs
        .positional("targetVersion", {
          type: "string",
          describe: "exact version to install",
        })
        .option("yes", {
          alias: "y",
          type: "boolean",
          describe: "skip confirmation",
        })
        .option("auto", {
          choices: ["on", "off"] as const,
          describe: "toggle automatic updates at TUI startup",
        });
    },
    async handler(args) {
      const { auto, targetVersion: requestedVersion } = args;
      if (auto !== undefined && auto !== "on" && auto !== "off") {
        runtime.failUsage("Pass --auto on or --auto off once.");
      }
      if (auto !== undefined && requestedVersion !== undefined) {
        runtime.failUsage("--auto cannot be used with a target version");
      }
      if (requestedVersion !== undefined && !isExactVersion(requestedVersion)) {
        runtime.failUsage("Specify an exact version, such as 0.1.19.");
      }
      try {
        if (!runtime.resolveOhbabyHome)
          throw new Error("The ohbaby configuration directory is unavailable.");
        const ohbabyHome = runtime.resolveOhbabyHome();
        if (auto !== undefined) {
          await setAutoUpdate(ohbabyHome, auto === "on");
          runtime.stdout.write(`Automatic updates are ${auto}.\n`);
          return;
        }

        const method = detectInstallMethod();
        if (method.kind === "other") {
          throw new Error(unsupportedInstall);
        }
        let targetVersion = requestedVersion;
        await runtime.initializeProxy?.();
        if (targetVersion === undefined) {
          targetVersion = await fetchLatestVersion();
          await writeVersionCache(ohbabyHome, targetVersion).catch(
            () => undefined,
          );
        }
        const currentVersion = getCliPackageVersion();
        if (targetVersion === currentVersion) {
          runtime.stdout.write(
            `ohbaby ${currentVersion} is already installed.\n`,
          );
          return;
        }
        runtime.stdout.write(
          `Update ohbaby from ${currentVersion} to ${targetVersion} (${method.kind})?\n`,
        );
        if (!args.yes) {
          if (!runtime.isStdinTTY())
            throw new Error("Pass -y to update in a non-interactive terminal.");
          runtime.stderr.write(
            "Press Enter to continue, or type n to cancel: ",
          );
          if (
            !["", "y", "yes"].includes((await readConfirmation(stdin)) ?? "n")
          )
            return;
        }
        const result = await performUpdate(
          { ohbabyHome, currentVersion, targetVersion, runtime },
          method,
          false,
        );
        if (!result.ok) throw new Error(result.message);
      } catch (error) {
        runtime.stderr.write(`${errorMessage(error)}\n`);
        runtime.setExitCode(1);
      }
    },
  };
}
