import { join } from "node:path";
import type { resolveOhbabyHome } from "ohbaby-agent";
import type {
  inspectDaemonForMaintenance,
  stopDaemonFromState,
} from "ohbaby-server";

import type { InstallMethod } from "../install/install-method.js";
import { findWindowsInstallBlockers } from "./windows-processes.js";

export interface UpgradePreflightOptions {
  readonly installMethod: InstallMethod;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export type UpgradePreflight =
  | { readonly ok: true; readonly stoppedDaemon: boolean }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface UpgradePreflightRuntime {
  readonly resolveOhbabyHome: typeof resolveOhbabyHome;
  readonly inspectDaemonForMaintenance: typeof inspectDaemonForMaintenance;
  readonly stopDaemonFromState: typeof stopDaemonFromState;
}

export async function runUpgradePreflight(
  {
    installMethod,
    platform = process.platform,
    env = process.env,
  }: UpgradePreflightOptions,
  {
    resolveOhbabyHome,
    inspectDaemonForMaintenance,
    stopDaemonFromState,
  }: UpgradePreflightRuntime,
): Promise<UpgradePreflight> {
  const options = { environment: env };
  const initial = await inspectDaemonForMaintenance(options);
  const blocked = (reason: string): UpgradePreflight => ({
    ok: false,
    reasons: [reason],
  });
  const unsafeDaemon = (reason: string): UpgradePreflight => {
    let logDirectory = env.OHBABY_LOG_DIR;
    if (!logDirectory) {
      try {
        logDirectory = join(resolveOhbabyHome(options), "logs");
      } catch {
        return blocked(reason);
      }
    }
    return {
      ok: false,
      reasons: [
        reason,
        `Check the logs in ${join(logDirectory, "serve")}. If the daemon can start, run ohbaby serve and stop it normally before trying again.`,
      ],
    };
  };

  if (initial.kind === "blocked") return unsafeDaemon(initial.reason);

  if (platform === "win32" && installMethod.kind === "npm") {
    try {
      const pids = await findWindowsInstallBlockers(
        env,
        initial.kind === "running" ? initial.target.pid : undefined,
      );
      if (pids.length)
        return blocked(
          `Close other ohbaby processes before continuing (PID ${pids.join(", ")}).`,
        );
    } catch (error) {
      return blocked(
        `Could not check for other ohbaby processes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let stoppedDaemon = false;
  if (initial.kind === "running") {
    const stop = await stopDaemonFromState({
      ...options,
      idleTarget: initial.target,
    });
    if (stop.rejection) return { ok: false, reasons: stop.rejection };
    // When it exited before our request, the final inspection still requires
    // a cleanup report for the same instance.
    if (
      stop.processExit !== "not-running" &&
      (stop.processExit !== "confirmed" || stop.cleanup !== "confirmed")
    )
      return unsafeDaemon(
        stop.reason ?? "Daemon exit and cleanup could not both be confirmed.",
      );
    stoppedDaemon = stop.requestAccepted === true;
  }

  const final = await inspectDaemonForMaintenance(options);
  if (final.kind === "blocked") return unsafeDaemon(final.reason);
  if (
    initial.kind === "empty"
      ? final.kind !== "empty"
      : final.kind !== "stopped" ||
        final.target.pid !== initial.target.pid ||
        final.target.token !== initial.target.token
  ) {
    return blocked(
      "The daemon changed during the check. Keep it stopped and try again.",
    );
  }
  return { ok: true, stoppedDaemon };
}
