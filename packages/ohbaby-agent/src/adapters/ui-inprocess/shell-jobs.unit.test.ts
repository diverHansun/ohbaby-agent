import { describe, expect, it, vi } from "vitest";
import type {
  UiShellJobAbandonInput,
  UiShellJobsInvalidatedEvent,
} from "ohbaby-sdk";
import { ShellJobProjection } from "./shell-jobs.js";
import { ShellJobReader } from "../../shell-jobs/reader.js";
import { InMemoryShellJobStore } from "../../shell-jobs/store.js";
import { shellJobFixture } from "../../shell-jobs/fixtures/shell-job.js";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup() {
  const store = new InMemoryShellJobStore();
  await store.insert(shellJobFixture());
  const validateRoot = vi.fn(() => Promise.resolve());
  const events: UiShellJobsInvalidatedEvent[] = [];
  const reader = new ShellJobReader({
    store,
    management: () =>
      Promise.resolve({ managedByCurrentBackend: true, canStop: true }),
  });
  const stop = vi.fn(
    async (): Promise<{ outcome: "accepted" | "already-terminal" }> => {
      await store.update("job", {
        status: "cancelled",
        stopReason: "user",
        cleanup: "unconfirmed",
      });
      return { outcome: "accepted" as const };
    },
  );
  const abandon = vi.fn(async () => {
    await store.update("job", { trackingReleasedAt: 123 });
  });
  const projection = new ShellJobProjection({
    store,
    reader,
    runtimeEpoch: "epoch",
    validateRoot,
    stop,
    abandon,
    publish: (event) => events.push(event),
  });
  return { store, reader, validateRoot, events, stop, abandon, projection };
}
const target = { rootSessionId: "s", jobId: "job" };
describe("backend shell job projection", () => {
  it("advances query versions independently of store notifications without producing a query loop", async () => {
    const s = await setup();
    const first = await s.projection.list({
      rootSessionId: "s",
      bindingGeneration: 7,
    });
    const second = await s.projection.list({ rootSessionId: "s" });
    expect(first).toMatchObject({
      runtimeEpoch: "epoch",
      bindingGeneration: 7,
      revision: 1,
    });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(s.events).toEqual([]);
    await s.store.update("job", { outputTail: "latest" });
    expect(s.events).toHaveLength(1);
    expect(s.events[0].revision).toBeGreaterThan(second.revision);
    const output = await s.projection.output(target);
    expect(output.output).toBe("latest");
    expect(output.revision).toBeGreaterThan(s.events[0].revision);
    s.projection.dispose();
    await s.store.update("job", { outputTail: "after dispose" });
    expect(s.events).toHaveLength(1);
    await expect(s.projection.list({ rootSessionId: "s" })).rejects.toThrow(
      "disposed",
    );
  });
  it("keeps a delayed older response at its captured revision", async () => {
    const s = await setup();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = s.reader.list.bind(s.reader);
    const read = vi
      .spyOn(s.reader, "list")
      .mockImplementationOnce(async (query, capture) => {
        const page = await original(query, capture);
        await wait;
        return page;
      });
    const pending = s.projection.list({ rootSessionId: "s" });
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    await s.store.update("job", { status: "failed" });
    const newer = await s.projection.list({ rootSessionId: "s" });
    release();
    const older = await pending;
    expect(older.rows[0].status).toBe("running");
    expect(newer.rows[0].status).toBe("failed");
    expect(older.revision).toBeLessThan(newer.revision);
    s.projection.dispose();
  });
  it("captures list versions after query-time recovery emits a change", async () => {
    const store = new InMemoryShellJobStore();
    await store.insert(shellJobFixture());
    const events: UiShellJobsInvalidatedEvent[] = [];
    const reader = new ShellJobReader({
      store,
      refreshRoot: async () => {
        await store.update("job", { status: "lost", cleanup: "unconfirmed" });
      },
      management: () =>
        Promise.resolve({ managedByCurrentBackend: false, canStop: false }),
    });
    const projection = new ShellJobProjection({
      store,
      reader,
      runtimeEpoch: "epoch",
      validateRoot: () => Promise.resolve(),
      stop: () => Promise.resolve({ outcome: "accepted" }),
      abandon: () => Promise.resolve(),
      publish: (event) => {
        events.push(event);
      },
    });
    await store.update("job", { outputTail: "before first read" });
    const page = await projection.list({ rootSessionId: "s" });
    expect(events).toHaveLength(2);
    expect(events[1].revision).toBeGreaterThan(events[0].revision);
    expect(page.revision).toBeGreaterThan(events[1].revision);
    expect(page.rows[0].status).toBe("lost");
    projection.dispose();
  });
  it("refuses a startup placeholder before control and returns the authoritative operation outcome", async () => {
    const s = await setup();
    await s.store.update("job", { status: null });
    await expect(s.projection.stop(target)).rejects.toMatchObject({
      code: "SHELL_JOB_NOT_READY",
    });
    expect(s.stop).not.toHaveBeenCalled();
    await s.store.update("job", { status: "running" });
    s.stop.mockImplementationOnce(async () => {
      await s.store.update("job", {
        status: "completed",
        cleanup: "confirmed",
        settledAt: 3,
      });
      return { outcome: "already-terminal" };
    });
    expect(await s.projection.stop(target)).toMatchObject({
      outcome: "already-terminal",
      job: { status: "completed" },
    });
    s.projection.dispose();
  });
  it("rechecks access after awaited reads and never controls a task from a different tree", async () => {
    const s = await setup();
    s.validateRoot
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("SESSION_SCOPE_CHANGED"));
    await expect(s.projection.output(target)).rejects.toThrow(
      "SESSION_SCOPE_CHANGED",
    );
    s.validateRoot.mockResolvedValue();
    await expect(
      s.projection.stop({ ...target, rootSessionId: "other" }),
    ).rejects.toMatchObject({ code: "SHELL_JOB_NOT_FOUND" });
    await expect(
      s.projection.abandon({
        ...target,
        rootSessionId: "other",
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: "SHELL_JOB_NOT_FOUND" });
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.abandon).not.toHaveBeenCalled();
    s.projection.dispose();
  });
  it("separates stop admission from cleanup and requires literal user confirmation for abandonment", async () => {
    const s = await setup();
    expect(await s.projection.stop(target)).toMatchObject({
      outcome: "accepted",
      job: { status: "cancelled", cleanup: "unconfirmed", stopReason: "user" },
    });
    await expect(
      s.projection.abandon({
        ...target,
        confirm: "true",
      } as unknown as UiShellJobAbandonInput),
    ).rejects.toThrow("confirm=true");
    expect(s.abandon).not.toHaveBeenCalled();
    expect(
      await s.projection.abandon({ ...target, confirm: true }),
    ).toMatchObject({
      trackingReleasedAt: 123,
      job: { cleanup: "unconfirmed", status: "cancelled" },
    });
    await s.store.update("job", { cleanup: "confirmed", settledAt: 456 });
    expect(await s.projection.stop(target)).toMatchObject({
      outcome: "already-terminal",
    });
    expect(s.stop).toHaveBeenCalledTimes(1);
    s.projection.dispose();
  });
});
