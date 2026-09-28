import { resolve } from "node:path";
import {
  NOOP_LOGGER,
  collectCleanup,
  createShutdownOptions,
  withinShutdown,
  type CleanupResult,
  serverStopFailed,
  serverStopped,
  type Logger,
} from "ohbaby-agent";
import { emitDiagnosticSafely } from "../../observability/emit.js";
import { FilePidFile } from "./pid-file.js";
import { JsonDaemonStateFile } from "./state-file.js";
import type {
  DaemonPidFile,
  DaemonPidLock,
  DaemonRuntimeHandle,
  DaemonSignalTarget,
  DaemonStateFile,
} from "./types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_STATE_DIR = ".ohbaby";

export type DaemonStopReason = "idle" | "requested" | "signal";

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage, { cause: error });
}

export interface SupervisorOptions {
  readonly pidFile?: DaemonPidFile;
  readonly stateFile?: DaemonStateFile;
  readonly pidFilePath?: string;
  readonly stateFilePath?: string;
  readonly bootstrap: () => DaemonRuntimeHandle | Promise<DaemonRuntimeHandle>;
  readonly signalTarget?: DaemonSignalTarget | null;
  readonly shutdownTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly exit?: (code: number) => void;
  readonly logger?: Logger;
  readonly disposeDiagnostics?: () => Promise<void>;
  readonly now?: () => number;
}

export class Supervisor {
  private readonly pidFile: DaemonPidFile;
  private readonly stateFile: DaemonStateFile;
  private readonly signalTarget: DaemonSignalTarget | null;
  private readonly shutdownTimeoutMs: number;
  private readonly exit: (code: number) => void;
  private readonly logger: Logger;
  private readonly now: () => number;
  private pidLock: DaemonPidLock | undefined;
  private runtime: DaemonRuntimeHandle | undefined;
  private startedAt: number | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopReason: DaemonStopReason = "requested";
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private signalsRegistered = false;
  private readonly activeClients = new Set<string>();

  private readonly signalHandler = (): void => {
    void this.stopAndExit("signal");
  };

  constructor(private readonly options: SupervisorOptions) {
    this.pidFile =
      options.pidFile ??
      new FilePidFile(
        options.pidFilePath ?? resolve(DEFAULT_STATE_DIR, "daemon.pid"),
        options.now,
      );
    this.stateFile =
      options.stateFile ??
      new JsonDaemonStateFile(
        options.stateFilePath ??
          resolve(DEFAULT_STATE_DIR, "daemon-state.json"),
      );
    this.signalTarget =
      options.signalTarget === undefined ? process : options.signalTarget;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.exit =
      options.exit ??
      ((code: number): never => {
        process.exit(code);
      });
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.runtime) {
      return;
    }

    this.stopPromise = undefined;
    try {
      this.pidLock = await this.pidFile.acquire();
      this.startedAt = this.now();
      this.runtime = await this.options.bootstrap();
      await this.runtime.start();
      await this.writeState("running");
      this.registerSignals();
    } catch (error) {
      if (this.pidLock) {
        try {
          await this.writeState("crashed", errorToMessage(error));
        } catch {
          // The original startup failure remains authoritative.
        }
      }
      try {
        await this.runtime?.stop();
      } catch {
        // The original startup failure remains authoritative.
      }
      try {
        await this.releasePidLock();
      } catch {
        // The original startup failure remains authoritative.
      } finally {
        this.unregisterSignals();
        this.runtime = undefined;
        this.startedAt = undefined;
      }
      throw toError(error, "daemon start failed");
    }
  }

  async stop(reason: DaemonStopReason = "requested"): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopReason = reason;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  clientConnected(clientId: string): void {
    this.activeClients.add(clientId);
    this.clearIdleTimer();
  }

  clientDisconnected(clientId: string): void {
    this.activeClients.delete(clientId);
    if (this.activeClients.size === 0) {
      this.scheduleIdleStop();
    }
  }

  async retire(reason: string): Promise<void> {
    void reason;
    await this.stop();
  }

  async stopAndExit(reason: DaemonStopReason = "requested"): Promise<void> {
    try {
      await this.stop(reason);
      this.exit(0);
    } catch {
      this.exit(1);
    }
  }

  private async stopInternal(): Promise<void> {
    const options = createShutdownOptions(this.shutdownTimeoutMs);
    // Reserve part of the same budget for final state and the token-scoped report.
    const cleanupOptions = {
      ...options,
      deadlineAt:
        options.deadlineAt - Math.min(100, this.shutdownTimeoutMs / 4),
    };
    const identity = this.pidLock?.record;
    const errors: string[] = [];
    try {
      this.runtime?.closeAdmission?.();
    } catch (error) {
      errors.push(errorToMessage(error));
    }
    this.clearIdleTimer();
    this.activeClients.clear();
    if (!this.runtime && !this.pidLock) return;

    const stopping = withinShutdown(cleanupOptions, "state.stopping", () =>
      this.writeState("stopping"),
    );
    const runtime = collectCleanup(cleanupOptions, {
      runtime: () => this.runtime?.stop(cleanupOptions),
    });
    try {
      await stopping;
    } catch (error) {
      errors.push(errorToMessage(error));
    }
    const runtimeResult = await runtime;
    errors.push(...runtimeResult.errors);
    try {
      await withinShutdown(options, "state.final", () =>
        this.writeState(
          runtimeResult.status === "confirmed" ? "stopped" : "crashed",
          runtimeResult.errors.at(0),
        ),
      );
    } catch (error) {
      errors.push(errorToMessage(error));
    }
    // Emit while the sink still accepts events; its disposal flushes this record.
    if (this.logger !== NOOP_LOGGER) {
      if (!errors.length)
        emitDiagnosticSafely(this.logger, serverStopped, {
          reason: this.stopReason,
        });
      else
        emitDiagnosticSafely(this.logger, serverStopFailed, {
          error: new Error(errors.join("; ")),
          reason: this.stopReason,
        });
    }
    const diagnostics = await collectCleanup(options, {
      diagnostics: async () => {
        try {
          await this.options.disposeDiagnostics?.();
        } catch {
          /* Ordinary logging errors are observational. */
        }
      },
    });
    errors.push(...diagnostics.errors);
    const finalCleanup = await collectCleanup(options, {
      "pid.release": () => this.releasePidLock(),
    });
    errors.push(...finalCleanup.errors);
    const cleanup: CleanupResult = {
      status: errors.length ? "unconfirmed" : "confirmed",
      errors,
    };
    try {
      if (identity && this.stateFile.writeShutdownReport) {
        await withinShutdown(
          options,
          "shutdown-report",
          () =>
            this.stateFile.writeShutdownReport?.({
              pid: identity.pid,
              pidToken: identity.token,
              recordedAt: this.now(),
              cleanup,
            }) ?? Promise.resolve(),
        );
      }
    } catch (error) {
      errors.push(errorToMessage(error));
    }
    this.unregisterSignals();
    this.runtime = undefined;
    this.startedAt = undefined;
    if (errors.length) throw new Error(errors.join("; "));
  }

  private scheduleIdleStop(): void {
    if (
      this.options.idleTimeoutMs === undefined ||
      this.idleTimer !== undefined ||
      this.runtime === undefined
    ) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.stop("idle").catch(() => undefined);
    }, this.options.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async writeState(
    status: "running" | "stopping" | "stopped" | "crashed",
    error?: string,
  ): Promise<void> {
    await this.stateFile.write({
      status,
      pid: process.pid,
      ...(this.pidLock?.record?.token === undefined
        ? {}
        : { pidToken: this.pidLock.record.token }),
      startedAt: this.startedAt,
      updatedAt: this.now(),
      error,
      ...(status === "running" && this.runtime?.connection
        ? this.runtime.connection
        : {}),
    });
  }

  private registerSignals(): void {
    if (!this.signalTarget || this.signalsRegistered) {
      return;
    }

    this.signalTarget.on("SIGTERM", this.signalHandler);
    this.signalTarget.on("SIGINT", this.signalHandler);
    if (process.platform !== "win32")
      this.signalTarget.on("SIGHUP", this.signalHandler);
    this.signalsRegistered = true;
  }

  private unregisterSignals(): void {
    if (!this.signalTarget || !this.signalsRegistered) {
      return;
    }

    this.signalTarget.off("SIGTERM", this.signalHandler);
    this.signalTarget.off("SIGINT", this.signalHandler);
    if (process.platform !== "win32")
      this.signalTarget.off("SIGHUP", this.signalHandler);
    this.signalsRegistered = false;
  }

  private async releasePidLock(): Promise<void> {
    const lock = this.pidLock;
    this.pidLock = undefined;
    await lock?.release();
  }
}
