import { expect, it, vi } from "vitest";
import { MaintenanceAdmission } from "./maintenance-admission.js";

it("reopens admission after cancellation and does not launch a late check", async () => {
  const gate = new MaintenanceAdmission();
  const release = gate.tryEnter();
  const getReasons = vi.fn(() => Promise.resolve([]));
  const accept = vi.fn(() => true);
  const client = new AbortController();
  const check = gate.check(client.signal, getReasons, accept);
  expect(gate.tryEnter()).toBeUndefined();
  try {
    client.abort();
    expect(await check).toEqual([expect.stringContaining("canceled")]);
    expect(gate.isPaused).toBe(false);
  } finally {
    release?.();
  }
  expect(getReasons).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
  expect(
    await gate.check(new AbortController().signal, getReasons, accept),
  ).toEqual([]);
  expect(accept).toHaveBeenCalledOnce();
  expect(gate.tryEnter()).toBeUndefined();
});

it("reopens admission after the check times out", async () => {
  vi.useFakeTimers();
  const gate = new MaintenanceAdmission();
  const release = gate.tryEnter();
  const getReasons = vi.fn(() => Promise.resolve([]));
  const accept = vi.fn(() => true);
  try {
    const check = gate.check(new AbortController().signal, getReasons, accept);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await check).toEqual([expect.stringContaining("timed out")]);
    expect(gate.isPaused).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  } finally {
    release?.();
    vi.useRealTimers();
  }
});
