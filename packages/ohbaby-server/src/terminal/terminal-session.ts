import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_ERROR_CODES,
  TERMINAL_MAX_BUFFER_BYTES,
  type TerminalInfo,
  type TerminalServerMessage,
} from "ohbaby-sdk";
import type { TerminalPty } from "./pty.js";
import { TerminalError } from "./errors.js";

export interface TerminalViewer {
  readonly open: boolean;
  readonly bufferedAmount: number;
  send(message: TerminalServerMessage): void;
  close(code: number): void;
}

/** One ordered screen, independent of the lifetime of any browser connection. */
export class TerminalSession {
  private currentInfo: TerminalInfo;
  private readonly screen: headless.Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private pty?: TerminalPty;
  private subscriptions: { dispose(): void }[] = [];
  private readonly viewers = new Set<TerminalViewer>();
  private operations: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private paused = false;
  private disposed = false;
  private exit?: { exitCode: number; signal?: number };
  private exitNotified = false;
  private closePromise?: Promise<void>;

  constructor(
    info: TerminalInfo,
    dimensions: { cols: number; rows: number },
    private readonly onClosed: () => void,
  ) {
    this.currentInfo = info;
    this.screen = new headless.Terminal({
      ...dimensions,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.screen.loadAddon(this.serializer);
  }

  get info(): TerminalInfo {
    return this.currentInfo;
  }

  start(pty: TerminalPty, shell: string): void {
    this.pty = pty;
    this.currentInfo = { ...this.currentInfo, shell };
    this.subscriptions.push(
      pty.onData((data) => {
        this.output(data);
      }),
    );
    this.subscriptions.push(
      pty.onExit((event) => {
        if (this.exit) return;
        this.exit = event;
        // Drain output received before exit so the final line precedes the exit frame.
        void this.enqueue(() => {
          this.notifyExit();
          if (this.currentInfo.state === "running") {
            // Do not await inside the screen queue: close itself drains that queue.
            void this.close(true).catch(() => {
              /* Keep failed cleanup discoverable. */
            });
          }
        });
      }),
    );
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const pending = this.operations.then(operation);
    // Each caller owns its error; cleanup must remain possible after a failure.
    this.operations = pending.catch(() => {
      /* The operation caller handles the error. */
    });
    return pending;
  }

  private output(data: string): void {
    if (this.disposed || !data.length) return;
    const bytes = Buffer.byteLength(data);
    this.pendingBytes += bytes;
    if (!this.paused && this.pendingBytes >= 512 * 1024) {
      this.paused = true;
      this.pty?.pause();
    }
    void this.enqueue(async () => {
      try {
        if (this.disposed) return;
        await new Promise<void>((resolve) => {
          this.screen.write(data, resolve);
        });
        for (const viewer of this.viewers)
          this.send(viewer, { type: "output", data });
      } finally {
        this.pendingBytes -= bytes;
        if (this.paused && this.pendingBytes <= 128 * 1024) {
          this.paused = false;
          this.pty?.resume();
        }
      }
    }).catch(() => {
      // A broken renderer must not affect the daemon or orphan the process.
      void this.close(true).catch(() => {
        /* Failed cleanup stays listed for retry. */
      });
    });
  }

  attach(viewer: TerminalViewer): Promise<void> {
    return this.enqueue(() => {
      if (!viewer.open) return;
      if (this.disposed || this.exit || this.currentInfo.state !== "running") {
        viewer.close(TERMINAL_CLOSE_CODES.NOT_FOUND);
        return;
      }
      const sent = this.send(viewer, {
        type: "snapshot",
        data: this.serializer.serialize(),
        cols: this.screen.cols,
        rows: this.screen.rows,
      });
      if (sent) this.viewers.add(viewer);
    });
  }

  detach(viewer: TerminalViewer): void {
    this.viewers.delete(viewer);
  }

  private send(
    viewer: TerminalViewer,
    message: TerminalServerMessage,
  ): boolean {
    if (!viewer.open) {
      this.viewers.delete(viewer);
      return false;
    }
    try {
      if (
        message.type !== "snapshot" &&
        viewer.bufferedAmount + Buffer.byteLength(JSON.stringify(message)) >
          TERMINAL_MAX_BUFFER_BYTES
      ) {
        viewer.close(TERMINAL_CLOSE_CODES.OVERFLOW);
        this.viewers.delete(viewer);
      } else viewer.send(message);
    } catch {
      this.viewers.delete(viewer);
      viewer.close(1011);
    }
    return viewer.open;
  }

  input(data: string): void {
    if (!this.disposed && !this.exit && this.currentInfo.state === "running")
      this.pty?.write(data);
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.enqueue(() => {
      if (this.disposed || this.exit || this.currentInfo.state !== "running")
        return;
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 2 ||
        cols > 500 ||
        rows < 1 ||
        rows > 200
      )
        return;
      this.pty?.resize(cols, rows);
      this.screen.resize(cols, rows);
    });
  }

  close(force = false): Promise<void> {
    if (this.closePromise) {
      return force
        ? this.closePromise.catch((error: unknown) => {
            // Shutdown must not inherit a concurrent user's busy confirmation result.
            if (
              error instanceof TerminalError &&
              error.code === TERMINAL_ERROR_CODES.BUSY
            )
              return this.close(true);
            throw error;
          })
        : this.closePromise;
    }
    this.closePromise = this.closeOnce(force).finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }

  private async closeOnce(force: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.currentInfo.state === "running" && !force && !this.exit) {
      const children = await this.pty?.inspectChildren();
      const child = children?.[0];
      if (child)
        throw new TerminalError(
          TERMINAL_ERROR_CODES.BUSY,
          "Terminal has running programs",
          409,
          child.name,
        );
    }
    this.currentInfo = {
      ...this.currentInfo,
      state: "closing",
      error: undefined,
    };
    try {
      // Resume before terminating; never wait for a browser's outbound queue.
      if (this.paused) {
        this.paused = false;
        this.pty?.resume();
      }
      await this.pty?.terminate();
      await this.operations;
      this.notifyExit();
      this.dispose();
      this.onClosed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.currentInfo = {
        ...this.currentInfo,
        state: "close_failed",
        error: message,
      };
      throw new TerminalError(TERMINAL_ERROR_CODES.CLOSE_FAILED, message, 500);
    }
  }

  private notifyExit(): void {
    if (this.exitNotified || !this.exit) return;
    this.exitNotified = true;
    for (const viewer of this.viewers) {
      this.send(viewer, { type: "exit", ...this.exit });
      viewer.close(TERMINAL_CLOSE_CODES.NORMAL);
    }
    this.viewers.clear();
  }

  /** Release resources also when creation fails before a PTY exists. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    for (const viewer of this.viewers)
      viewer.close(TERMINAL_CLOSE_CODES.NORMAL);
    this.viewers.clear();
    this.screen.dispose();
  }
}
