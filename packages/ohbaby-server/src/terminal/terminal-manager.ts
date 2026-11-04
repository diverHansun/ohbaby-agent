import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { TERMINAL_ERROR_CODES, type TerminalInfo } from "ohbaby-sdk";
import type { TerminalPty } from "./pty.js";
import { TerminalError } from "./errors.js";
import { TerminalSession } from "./terminal-session.js";

interface CreateOptions {
  directory: string;
  cols: number;
  rows: number;
}
interface ManagerOptions {
  createPty?: (
    options: CreateOptions,
  ) => Promise<{ pty: TerminalPty; shell: string }>;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalSession>();
  private readonly pending = new Set<Promise<TerminalInfo>>();
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly createPty: NonNullable<ManagerOptions["createPty"]>;

  constructor(options: ManagerOptions = {}) {
    this.createPty =
      options.createPty ??
      (async (input): Promise<{ pty: TerminalPty; shell: string }> => {
        const { createTerminalPty } = await import("./pty.js");
        return createTerminalPty(input);
      });
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((session) => session.info);
  }
  get(id: string): TerminalSession | undefined {
    return this.terminals.get(id);
  }

  create(options: CreateOptions): Promise<TerminalInfo> {
    if (this.stopping)
      return Promise.reject(
        new TerminalError(
          TERMINAL_ERROR_CODES.STOPPING,
          "Terminal manager is stopping",
          503,
        ),
      );
    if (this.terminals.size + this.pending.size >= 16)
      return Promise.reject(
        new TerminalError(
          TERMINAL_ERROR_CODES.LIMIT_REACHED,
          "已经开了 16 个终端，关掉不用的再试",
          409,
        ),
      );
    if (
      !Number.isInteger(options.cols) ||
      !Number.isInteger(options.rows) ||
      options.cols < 2 ||
      options.cols > 500 ||
      options.rows < 1 ||
      options.rows > 200
    ) {
      return Promise.reject(
        new TerminalError(
          TERMINAL_ERROR_CODES.INVALID_REQUEST,
          "Invalid terminal dimensions",
          400,
        ),
      );
    }
    // Reserve synchronously, before any import/spawn can yield to another request.
    const task = Promise.resolve().then(async () => {
      const id = randomUUID();
      const info: TerminalInfo = {
        id,
        directory: options.directory,
        title:
          resolve(options.directory) === resolve(homedir())
            ? "~"
            : basename(options.directory) || options.directory,
        shell: "",
        createdAt: Date.now(),
        state: "running",
      };
      let session: TerminalSession | undefined;
      try {
        // Screen allocation comes first: failure here cannot leave a running PTY.
        session = new TerminalSession(info, options, () => {
          this.terminals.delete(id);
        });
        const { pty, shell } = await this.createPty(options);
        this.pending.delete(task);
        this.terminals.set(id, session);
        session.start(pty, shell);
        if (this.stopping) {
          await session.close(true);
          throw new TerminalError(
            TERMINAL_ERROR_CODES.STOPPING,
            "Terminal manager is stopping",
            503,
          );
        }
        return session.info;
      } catch (error) {
        if (session && this.terminals.has(id)) {
          // Keep a failed cleanup in the registry so list/close can find it.
          if (session.info.state !== "close_failed") await session.close(true);
        } else session?.dispose();
        if (error instanceof TerminalError) throw error;
        throw new TerminalError(
          TERMINAL_ERROR_CODES.UNAVAILABLE,
          error instanceof Error ? error.message : String(error),
          503,
        );
      } finally {
        this.pending.delete(task);
      }
    });
    this.pending.add(task);
    return task;
  }

  close(id: string, force = false): Promise<void> {
    const session = this.terminals.get(id);
    if (!session)
      return Promise.reject(
        new TerminalError(
          TERMINAL_ERROR_CODES.NOT_FOUND,
          "Terminal not found",
          404,
        ),
      );
    return session.close(force);
  }

  closeAdmission(): void {
    this.stopping = true;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closeAdmission();
    this.stopPromise = (async (): Promise<void> => {
      const results = await Promise.allSettled([
        ...[...this.terminals.values()].map((session) => session.close(true)),
        ...this.pending,
      ]);
      const failures: unknown[] = [];
      for (const result of results) {
        if (result.status !== "rejected") continue;
        const error: unknown = result.reason;
        if (
          error instanceof TerminalError &&
          (error.code === TERMINAL_ERROR_CODES.STOPPING ||
            error.code === TERMINAL_ERROR_CODES.UNAVAILABLE)
        )
          continue;
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Terminal cleanup failed");
    })();
    return this.stopPromise;
  }
}
