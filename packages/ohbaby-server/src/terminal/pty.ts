import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IPty } from "@lydell/node-pty";
import { shellLaunchCandidates } from "./shell-launch.js";
import {
  collectTerminalProcesses,
  readProcessTable,
  readProcessTableSync,
  signalTerminalProcess,
  sameProcess,
  type TerminalProcess,
} from "./process-tree.js";

export interface TerminalPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  inspectChildren(): Promise<readonly { pid: number; name: string }[]>;
  terminate(): Promise<void>;
}

interface Exit {
  exitCode: number;
  signal?: number;
}
interface Disposable {
  dispose(): void;
}
let nativeModule: Promise<typeof import("@lydell/node-pty")> | undefined;

class NativeTerminalPty implements TerminalPty {
  readonly pid: number;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: Exit) => void>();
  private readonly dataSubscription: Disposable;
  private readonly exitSubscription: Disposable;
  private exit: Exit | undefined;
  private root: TerminalProcess | undefined;
  private members: TerminalProcess[] = [];
  private paused = false;
  private cleanup: Promise<void> | undefined;

  constructor(private readonly native: IPty) {
    this.pid = native.pid;
    this.dataSubscription = native.onData((data) => {
      for (const listener of this.dataListeners) listener(data);
    });
    this.exitSubscription = native.onExit((event) => {
      if (this.exit) return;
      this.exit = event;
      this.dataSubscription.dispose();
      this.exitSubscription.dispose();
      this.dataListeners.clear();
      for (const listener of this.exitListeners) listener(event);
      this.exitListeners.clear();
    });
    if (process.platform !== "win32") {
      // Capture before yielding: the numeric PID alone cannot authorize later signals.
      // An unavailable process table remains a retryable inspection/cleanup error.
      try {
        this.capture(readProcessTableSync());
      } catch {
        /* inspectChildren/terminate retries */
      }
    }
  }

  write(data: string): void {
    this.native.write(data);
  }
  resize(cols: number, rows: number): void {
    this.native.resize(cols, rows);
  }
  pause(): void {
    if (!this.exit) {
      this.paused = true;
      this.native.pause();
    }
  }
  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.native.resume();
    }
  }
  onData(listener: (data: string) => void): Disposable {
    if (!this.exit) this.dataListeners.add(listener);
    return {
      dispose: (): void => {
        this.dataListeners.delete(listener);
      },
    };
  }
  onExit(listener: (event: Exit) => void): Disposable {
    this.exitListeners.add(listener);
    const exit = this.exit;
    if (exit)
      queueMicrotask(() => {
        if (this.exitListeners.delete(listener)) listener(exit);
      });
    return {
      dispose: (): void => {
        this.exitListeners.delete(listener);
      },
    };
  }

  private capture(rows: TerminalProcess[]): TerminalProcess[] {
    if (!this.root && !this.exit)
      this.root = rows.find((row) => row.pid === this.pid);
    if (this.root) {
      const root = this.root;
      this.root = rows.find((row) => sameProcess(row, root)) ?? root;
      this.members = collectTerminalProcesses(rows, this.root, this.members);
    } else if (!this.exit)
      throw new Error(`Cannot identify terminal shell ${String(this.pid)}`);
    return this.members;
  }
  async inspectChildren(): Promise<readonly { pid: number; name: string }[]> {
    if (process.platform === "win32") return [];
    return this.capture(await readProcessTable())
      .filter((member) => member.pid !== this.pid)
      .map(({ pid, name }) => ({ pid, name }));
  }

  terminate(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    const cleanup = this.close();
    this.cleanup = cleanup;
    void cleanup.catch(() => {
      this.cleanup = undefined;
    });
    return cleanup;
  }

  private async waitForMembers(deadline: number): Promise<TerminalProcess[]> {
    let members = this.capture(await readProcessTable());
    while ((members.length > 0 || !this.exit) && Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      members = this.capture(await readProcessTable());
    }
    return members;
  }
  private async close(): Promise<void> {
    this.resume();
    if (process.platform === "win32") {
      if (!this.exit) this.native.kill(); // Windows node-pty rejects signal arguments.
      const deadline = Date.now() + 3000;
      while (!this.exit && Date.now() < deadline) await delay(25);
      if (!this.exit)
        throw new Error(`Terminal shell ${String(this.pid)} did not exit`);
      return;
    }
    const captured = this.capture(await readProcessTable());
    const root = captured.find((member) => member.pid === this.pid);
    if (root) signalTerminalProcess(root, "SIGHUP");
    let survivors = await this.waitForMembers(Date.now() + 2000);
    const signalErrors: unknown[] = [];
    for (const member of [...survivors].reverse()) {
      try {
        signalTerminalProcess(member, "SIGKILL");
      } catch (error) {
        signalErrors.push(error);
      }
    }
    survivors = await this.waitForMembers(Date.now() + 1000);
    if (survivors.length || !this.exit) {
      throw new AggregateError(
        signalErrors,
        `Terminal cleanup failed; surviving pids: ${survivors.map((member) => member.pid).join(", ") || String(this.pid)}`,
      );
    }
  }
}

function executable(file: string, env: NodeJS.ProcessEnv): boolean {
  const candidates = isAbsolute(file)
    ? [file]
    : (env.PATH ?? "").split(delimiter).map((path) => join(path, file));
  return candidates.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export async function createTerminalPty(options: {
  directory: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pty: TerminalPty; shell: string }> {
  // Cache the rejected promise as well: a missing native binary must not break serve startup.
  nativeModule ??= import("@lydell/node-pty");
  const nodePty = await nativeModule;
  const candidates = shellLaunchCandidates(options.directory, options.env);
  const launch = candidates.find(({ file, env }) => executable(file, env));
  if (!launch) throw new Error("No executable terminal shell found");
  const native = nodePty.spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    encoding: "utf8",
  });
  return {
    pty: new NativeTerminalPty(native),
    shell: basename(launch.file).replace(/\.exe$/i, ""),
  };
}
