import { expect, it, vi } from "vitest";
import { createTerminalCommand } from "./terminal.js";
import type { CliCommandRuntime } from "./types.js";

it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "waits for terminal restoration and transcript drain before host teardown on %s",
  async (signal) => {
    const order: string[] = [];
    let finishDrain = (): void => undefined;
    const drained = new Promise<void>((resolve) => {
      finishDrain = (): void => {
        order.push("stdout-drained");
        resolve();
      };
    });
    const dispose = vi.fn(() => {
      order.push("host-disposed");
      return Promise.resolve();
    });
    const unmount = vi.fn(() => {
      order.push("terminal-unmounted");
    });
    const onHostShutdownComplete = vi.fn(() => {
      order.push("shutdown-complete");
    });
    const runtime = {
      createCoreHost: () => ({
        core: {},
        callbacks: { subscribeEvents: (): (() => void) => () => undefined },
        closeAdmission: (): void => {
          order.push("admission-closed");
        },
        dispose,
      }),
      renderTerminalUi: () => ({
        unmount,
        waitUntilExit: (): Promise<void> => drained,
      }),
      onHostShutdownComplete,
      stderr: { write: vi.fn() },
    } as unknown as CliCommandRuntime;
    const running = createTerminalCommand(runtime).handler({} as never);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.emit(signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unmount).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      expect(onHostShutdownComplete).not.toHaveBeenCalled();
      finishDrain();
      await running;
      expect(order).toEqual([
        "admission-closed",
        "terminal-unmounted",
        "stdout-drained",
        "host-disposed",
        "shutdown-complete",
      ]);
    } finally {
      finishDrain();
      await running;
    }
  },
);
