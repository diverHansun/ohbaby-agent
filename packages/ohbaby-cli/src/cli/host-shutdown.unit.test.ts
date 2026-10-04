import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createCliHostShutdown } from "./host-shutdown.js";
import type { ShutdownOptions } from "ohbaby-agent";

it.each([
  { platform: "win32", supported: ["SIGINT", "SIGTERM"] },
  { platform: "darwin", supported: ["SIGINT", "SIGTERM", "SIGHUP"] },
  { platform: "linux", supported: ["SIGINT", "SIGTERM", "SIGHUP"] },
])(
  "handles and cleans up supported signals on $platform",
  async ({ platform, supported }) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const signals = new EventEmitter();
      const closeAdmission = vi.fn();
      const dispose = vi.fn(() => Promise.resolve());
      const onSignal = vi.fn();
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      if (!originalPlatform)
        throw new Error("process.platform descriptor missing");
      let shutdown: ReturnType<typeof createCliHostShutdown>;
      try {
        Object.defineProperty(process, "platform", { value: platform });
        shutdown = createCliHostShutdown(
          { closeAdmission, dispose },
          onSignal,
          signals,
        );
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      try {
        const expectedCalls = supported.includes(signal) ? 1 : 0;
        expect(signals.emit(signal)).toBe(expectedCalls === 1);
        expect(closeAdmission).toHaveBeenCalledTimes(expectedCalls);
        expect(onSignal).toHaveBeenCalledTimes(expectedCalls);
        expect(dispose).not.toHaveBeenCalled();
        if (expectedCalls === 1) await shutdown.interrupted;
      } finally {
        await shutdown.dispose();
      }
      expect(dispose).toHaveBeenCalledOnce();
      expect(signals.eventNames()).toEqual([]);
    }
  },
);

it("seals admission on the signal turn and reuses its one deadline through cleanup", async () => {
  const signals = new EventEmitter();
  const closeAdmission = vi.fn();
  const dispose = vi.fn((_options?: ShutdownOptions) => Promise.resolve());
  const onSignal = vi.fn();
  const shutdown = createCliHostShutdown(
    { closeAdmission, dispose },
    onSignal,
    signals,
  );
  signals.emit("SIGTERM");
  expect(closeAdmission).toHaveBeenCalledOnce();
  expect(onSignal).toHaveBeenCalledOnce();
  await shutdown.interrupted;
  await shutdown.dispose();
  await shutdown.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(dispose.mock.calls[0]?.[0]?.deadlineAt).toBeGreaterThan(Date.now());
  expect(dispose.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});
