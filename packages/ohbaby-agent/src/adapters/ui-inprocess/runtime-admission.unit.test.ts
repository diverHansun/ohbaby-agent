import { coordinateModelConfig } from "../../config/llm/config-coordination.js";
import { describe, expect, it, vi } from "vitest";
import {
  InProcessRuntimeController,
  RuntimeSwitchPendingError,
} from "./runtime-controller.js";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";

function fixture(): {
  controller: InProcessRuntimeController;
  created: string[];
  disposed: string[];
  save(v: string): void;
  setBusy(b: boolean): void;
} {
  let version = "A";
  let busy = false;
  const created: string[] = [];
  const disposed: string[] = [];
  const controller = new InProcessRuntimeController({
    clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
    updateStatus: (): Promise<void> => Promise.resolve(),
    publishNotice: vi.fn(),
    getConfigVersion: (): Promise<string> => Promise.resolve(version),
    createRuntime: (): Promise<UiRuntimeComposition> => {
      const model = version;
      created.push(model);
      return Promise.resolve({
        getActivityReasons: (): readonly string[] =>
          busy ? ["background shell jobs"] : [],
        dispose: (): Promise<void> => {
          disposed.push(model);
          return Promise.resolve();
        },
      } as unknown as UiRuntimeComposition);
    },
  });
  return {
    controller,
    created,
    disposed,
    save: (v: string): void => {
      version = v;
    },
    setBusy: (b: boolean): void => {
      busy = b;
    },
  };
}

describe("runtime model admission", () => {
  it("keeps the entire admitted work on A, and admits only latest C after release", async () => {
    const f = fixture();
    const old = await f.controller.acquireRuntime();
    f.save("B");
    await expect(f.controller.acquireRuntime()).rejects.toBeInstanceOf(
      RuntimeSwitchPendingError,
    );
    expect(await f.controller.getRuntime()).toBe(old.runtime);
    f.save("C");
    expect(f.disposed).toEqual([]);
    old.release();
    const next = await f.controller.acquireRuntime();
    expect(next.runtime).not.toBe(old.runtime);
    expect(f.created).toEqual(["A", "C"]);
    expect(f.disposed).toEqual(["A"]);
    next.release();
  });
  it("waits for background work even without any main run, then admits immediately", async () => {
    const f = fixture();
    (await f.controller.acquireRuntime()).release();
    f.setBusy(true);
    f.save("B");
    await expect(f.controller.acquireRuntime()).rejects.toThrow(
      "background shell jobs",
    );
    f.setBusy(false);
    (await f.controller.acquireRuntime()).release();
    expect(f.created).toEqual(["A", "B"]);
  });
  it("serializes admission so a newly admitted run cannot lose its runtime", async () => {
    const f = fixture();
    const [one, two] = await Promise.all([
      f.controller.acquireRuntime(),
      f.controller.acquireRuntime(),
    ]);
    expect(one.runtime).toBe(two.runtime);
    f.save("B");
    one.release();
    one.release();
    await expect(f.controller.acquireRuntime()).rejects.toBeInstanceOf(
      RuntimeSwitchPendingError,
    );
    two.release();
    (await f.controller.acquireRuntime()).release();
  });
  it("lets a manual summary join its active old run and keeps it alive through summary cleanup", async () => {
    const f = fixture();
    const old = await f.controller.acquireRuntime();
    f.save("B");
    const summary = await f.controller.acquireRuntime(true);
    expect(summary.runtime).toBe(old.runtime);
    old.release();
    await expect(f.controller.acquireRuntime()).rejects.toBeInstanceOf(
      RuntimeSwitchPendingError,
    );
    summary.release();
    (await f.controller.acquireRuntime()).release();
    expect(f.created).toEqual(["A", "B"]);
  });
  it("does not fall back to A when a newly saved configuration cannot initialize", async () => {
    let version = "A";
    const dispose = vi.fn((): Promise<void> => Promise.resolve());
    const old = {
      dispose,
      getActivityReasons: (): readonly string[] => [],
    } as unknown as UiRuntimeComposition;
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      updateStatus: (): Promise<void> => Promise.resolve(),
      publishNotice: vi.fn(),
      getConfigVersion: (): Promise<string> => Promise.resolve(version),
      createRuntime: (): Promise<UiRuntimeComposition> => {
        if (version === "B")
          return Promise.reject(new Error("Saved model B unavailable"));
        return Promise.resolve(old);
      },
    });
    (await controller.acquireRuntime()).release();
    version = "B";
    await expect(controller.acquireRuntime()).rejects.toThrow(
      "Saved model B unavailable",
    );
    await expect(controller.acquireRuntime()).rejects.toThrow(
      "Saved model B unavailable",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("rejects pending admissions on shutdown while force reset still disposes the old runtime", async () => {
    const f = fixture();
    const old = await f.controller.acquireRuntime();
    f.save("B");
    f.controller.close();
    await expect(f.controller.acquireRuntime()).rejects.toThrow(
      "shutting down",
    );
    await f.controller.resetRuntime();
    expect(f.disposed).toEqual(["A"]);
    old.release();
  });
  it("does not hold config publication while disposing, even if a concurrent reader starts replacement", async () => {
    let version = "A";
    let release!: () => void;
    let entered!: () => void;
    const disposing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      updateStatus: (): Promise<void> => Promise.resolve(),
      publishNotice: vi.fn(),
      coordinateAdmission: <T>(work: () => Promise<T>): Promise<T> =>
        coordinateModelConfig("/tmp/stage-b-admission-regression", work),
      getConfigVersion: (): Promise<string> => Promise.resolve(version),
      createRuntime: (): Promise<UiRuntimeComposition> =>
        Promise.resolve({
          getActivityReasons: (): readonly string[] => [],
          dispose: async (): Promise<void> => {
            entered();
            await gate;
          },
        } as unknown as UiRuntimeComposition),
    });
    (await controller.acquireRuntime()).release();
    version = "B";
    const admission = controller.acquireRuntime();
    await disposing;
    const reader = controller.getRuntime();
    release();
    const result = await Promise.race([
      Promise.all([admission, reader]).then(() => "completed"),
      new Promise<string>((resolve) =>
        setTimeout(() => {
          resolve("deadlocked");
        }, 150),
      ),
    ]);
    expect(result).toBe("completed");
    (await admission).release();
  });
});
