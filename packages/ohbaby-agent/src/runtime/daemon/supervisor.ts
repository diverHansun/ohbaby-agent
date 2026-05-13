import process from "node:process";
import { resolve } from "node:path";
import { FilePidFile } from "./pid-file.js";
import { JsonDaemonStateFile } from "./state-file.js";
import type {
  DaemonLogger,
  DaemonPidFile,
  DaemonPidLock,
  DaemonRuntimeHandle,
  DaemonSignalTarget,
  DaemonStateFile,
} from "./types.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_STATE_DIR = ".ohbaby";

const CONSOLE_LOGGER: DaemonLogger = {
  info(message: string, metadata?: Record<string, unknown>): void {
    process.stdout.write(`${message} ${JSON.stringify(metadata ?? {})}\n`);
  },
  error(message: string, metadata?: Record<string, unknown>): void {
    process.stderr.write(`${message} ${JSON.stringify(metadata ?? {})}\n`);
  },
};

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
  readonly exit?: (code: number) => void;
  readonly logger?: DaemonLogger;
  readonly now?: () => number;
}

export class Supervisor {
  private readonly pidFile: DaemonPidFile;
  private readonly stateFile: DaemonStateFile;
  private readonly signalTarget: DaemonSignalTarget | null;
  private readonly shutdownTimeoutMs: number;
  private readonly exit: (code: number) => void;
  private readonly logger: DaemonLogger;
  private readonly now: () => number;
  private pidLock: DaemonPidLock | undefined;
  private runtime: DaemonRuntimeHandle | undefined;
  private startedAt: number | undefined;
  private stopPromise: Promise<void> | undefined;
  private signalsRegistered = false;

  private readonly signalHandler = (): void => {
    void this.stopWithTimeout()
      .then(() => {
        this.exit(0);
      })
      .catch((error: unknown) => {
        this.logger.error("daemon graceful shutdown failed", {
          error: errorToMessage(error),
        });
        this.exit(1);
      });
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
    this.logger = options.logger ?? CONSOLE_LOGGER;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.runtime) {
      return;
    }

    try {
      this.pidLock = await this.pidFile.acquire();
      this.startedAt = this.now();
      await this.writeState("running");
      this.runtime = await this.options.bootstrap();
      await this.runtime.start();
      this.registerSignals();
      this.logger.info("daemon started");
    } catch (error) {
      if (this.pidLock) {
        try {
          await this.writeState("crashed", errorToMessage(error));
        } catch (stateError) {
          this.logger.error("daemon crash state write failed", {
            error: errorToMessage(stateError),
          });
        }
      }
      try {
        await this.runtime?.stop();
      } catch (cleanupError) {
        this.logger.error("daemon start cleanup failed", {
          error: errorToMessage(cleanupError),
        });
      }
      try {
        await this.releasePidLock();
      } catch (cleanupError) {
        this.logger.error("daemon pid release failed", {
          error: errorToMessage(cleanupError),
        });
      } finally {
        this.unregisterSignals();
        this.runtime = undefined;
        this.startedAt = undefined;
      }
      throw toError(error, "daemon start failed");
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.unregisterSignals();

    if (!this.runtime && !this.pidLock) {
      this.stopPromise = undefined;
      return;
    }

    let pendingError: unknown;
    let runtimeStopped = false;

    try {
      await this.writeState("stopping");
    } catch (error) {
      pendingError = error;
    }

    try {
      await this.runtime?.stop();
      runtimeStopped = true;
    } catch (error) {
      pendingError ??= error;
    }

    if (runtimeStopped) {
      try {
        await this.writeState("stopped");
        this.logger.info("daemon stopped");
      } catch (error) {
        pendingError ??= error;
      }
    } else {
      try {
        await this.writeState(
          "crashed",
          errorToMessage(pendingError ?? new Error("daemon stop failed")),
        );
      } catch (error) {
        pendingError ??= error;
      }
    }

    try {
      await this.releasePidLock();
    } catch (error) {
      pendingError ??= error;
    } finally {
      this.runtime = undefined;
      this.startedAt = undefined;
      this.stopPromise = undefined;
    }

    if (pendingError !== undefined) {
      throw toError(pendingError, "daemon stop failed");
    }
  }

  private async stopWithTimeout(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.stop(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("daemon shutdown timed out"));
          }, this.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async writeState(
    status: "running" | "stopping" | "stopped" | "crashed",
    error?: string,
  ): Promise<void> {
    await this.stateFile.write({
      status,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      error,
    });
  }

  private registerSignals(): void {
    if (!this.signalTarget || this.signalsRegistered) {
      return;
    }

    this.signalTarget.on("SIGTERM", this.signalHandler);
    this.signalTarget.on("SIGINT", this.signalHandler);
    this.signalsRegistered = true;
  }

  private unregisterSignals(): void {
    if (!this.signalTarget || !this.signalsRegistered) {
      return;
    }

    this.signalTarget.off("SIGTERM", this.signalHandler);
    this.signalTarget.off("SIGINT", this.signalHandler);
    this.signalsRegistered = false;
  }

  private async releasePidLock(): Promise<void> {
    const lock = this.pidLock;
    this.pidLock = undefined;
    await lock?.release();
  }
}
