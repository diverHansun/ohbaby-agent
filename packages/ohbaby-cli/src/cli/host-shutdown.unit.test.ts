import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createCliHostShutdown } from "./host-shutdown.js";
import type { ShutdownOptions } from "ohbaby-agent";

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
