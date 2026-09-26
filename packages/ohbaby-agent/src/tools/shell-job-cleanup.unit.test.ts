import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShellJobRegistry,
  type ShellJobSnapshot,
} from "./shell-job-registry.js";

class Child extends EventEmitter {
  readonly pid = 424242;
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
}
const start = (
  registry: ShellJobRegistry,
  child: Child,
  extra = {},
): ShellJobSnapshot =>
  registry.start({
    child: child as unknown as ChildProcess,
    sessionId: "cleanup-test",
    timeoutMs: 10000,
    ...extra,
  });
afterEach(() => vi.useRealTimers());
describe("shell job cleanup ownership", () => {
  it("returns the logical cancellation before cleanup and accepts late evidence without changing the outcome", async () => {
    vi.useFakeTimers();
    let state: "running" | "stopped" = "running";
    const killTree = vi.fn(
      () =>
        new Promise<void>(() => {
          /* Test-owned unresolved operation. */
        }),
    );
    const release = vi.fn();
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (): "running" | "stopped" | "unknown" => state,
      cleanupObservationMs: 50,
    });
    const child = new Child();
    const job = start(registry, child, { release });
    const result = await registry.kill(job.jobId, "cleanup-test");
    expect(result.metadata).toMatchObject({
      status: "cancelled",
      cleanup: "in-progress",
    });
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "unconfirmed",
    );
    child.emit("close", 0, null);
    expect(release).not.toHaveBeenCalled();
    state = "stopped";
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(registry.get(job.jobId, "cleanup-test").metadata).toMatchObject({
      status: "cancelled",
      cleanup: "confirmed",
    });
    expect(release).toHaveBeenCalledTimes(1);
    await registry.kill(job.jobId, "cleanup-test");
    expect(killTree).toHaveBeenCalledTimes(1);
  });
  it("retains unconfirmed jobs through pruning and scope disposal without sending signals twice", async () => {
    let state: "running" | "stopped" = "running";
    const killTree = vi.fn(() => Promise.reject(new Error("kill failed")));
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (): "running" | "stopped" | "unknown" => state,
    });
    const child = new Child();
    const job = start(registry, child);
    await registry.kill(job.jobId, "cleanup-test");
    await Promise.resolve();
    await registry.disposeSession("cleanup-test");
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "unconfirmed",
    );
    state = "stopped";
    for (let i = 0; i < 105; i++) {
      const done = new Child();
      start(registry, done);
      done.emit("close", 0, null);
    }
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "unconfirmed",
    );
    expect(killTree).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
    expect(registry.hasActiveWork()).toBe(false);
  });
  it("confirms stopped processes before bounded output drain and does not kill for open pipes", async () => {
    vi.useFakeTimers();
    const killTree = vi.fn();
    const release = vi.fn();
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (): "stopped" => "stopped",
      outputDrainMs: 30,
    });
    const child = new Child();
    const job = start(registry, child, { release });
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "confirmed",
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(registry.get(job.jobId, "cleanup-test").status).toBe("completed");
    expect(killTree).not.toHaveBeenCalled();
  });
  it("uses the terminator observation clock rather than an earlier registry deadline", async () => {
    vi.useFakeTimers();
    let complete!: (value: { status: "confirmed" }) => void;
    const registry = new ShellJobRegistry({
      killTree: (): Promise<{ status: "confirmed" }> =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      terminationManagesObservation: true,
      probeTree: (): "running" => "running",
    });
    const child = new Child();
    const job = start(registry, child);
    await registry.kill(job.jobId, "cleanup-test");
    await vi.advanceTimersByTimeAsync(1201);
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "in-progress",
    );
    complete({ status: "confirmed" });
    await Promise.resolve();
    child.emit("close", null, "SIGKILL");
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "confirmed",
    );
  });
  it("preserves the normal shell result while unproven descendants retain lifetime cleanup", async () => {
    vi.useFakeTimers();
    let state: "unknown" | "stopped" = "unknown";
    const release = vi.fn();
    const killTree = vi.fn(() =>
      Promise.resolve({ status: "unconfirmed" as const }),
    );
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (): "running" | "stopped" | "unknown" => state,
    });
    const child = new Child();
    const job = start(registry, child, { timeoutMs: 50, release });
    child.emit("close", 0, null);
    expect(registry.get(job.jobId, "cleanup-test").status).toBe("completed");
    expect(release).not.toHaveBeenCalled();
    expect(registry.hasActiveWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(registry.get(job.jobId, "cleanup-test").metadata).toMatchObject({
      status: "completed",
      cleanup: "unconfirmed",
    });
    await registry.disposeSession("cleanup-test");
    expect(killTree).toHaveBeenCalledTimes(1);
    state = "stopped";
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports environment disposal failure without retracting confirmed process cleanup", async () => {
    const reportCleanup =
      vi.fn<(state: "in-progress" | "confirmed" | "unconfirmed") => void>();
    const reportCleanupError = vi.fn();
    const failure = new Error("adapter disposal failed");
    const registry = new ShellJobRegistry({
      killTree: (): { status: "confirmed" } => ({ status: "confirmed" }),
      probeTree: (): "running" => "running",
    });
    const child = new Child();
    const job = start(registry, child, {
      reportCleanup,
      reportCleanupError,
      release: () => Promise.reject(failure),
    });
    await registry.kill(job.jobId, "cleanup-test");
    child.emit("close", null, "SIGTERM");
    await vi.waitFor(() => {
      expect(reportCleanupError).toHaveBeenCalledWith(failure);
    });
    expect(reportCleanup.mock.calls.map(([state]) => state)).toEqual([
      "in-progress",
      "confirmed",
    ]);
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "confirmed",
    );
  });
  it("does not let an uncertain exit probe end the terminator's bounded observation", async () => {
    let complete!: (result: { status: "confirmed" }) => void;
    const registry = new ShellJobRegistry({
      killTree: (): Promise<{ status: "confirmed" }> =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      terminationManagesObservation: true,
      probeTree: (): "unknown" => "unknown",
    });
    const child = new Child();
    const job = start(registry, child);
    await registry.kill(job.jobId, "cleanup-test");
    child.emit("exit", null, "SIGTERM");
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "in-progress",
    );
    complete({ status: "confirmed" });
    await Promise.resolve();
    child.emit("close", null, "SIGTERM");
    expect(registry.get(job.jobId, "cleanup-test").metadata.cleanup).toBe(
      "confirmed",
    );
  });
});
