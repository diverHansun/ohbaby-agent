import type { SettingsConfigVersions } from "../../config/llm/config-coordination.js";
import { coordinateModelConfig } from "../../config/llm/config-coordination.js";
import { describe, expect, it, vi } from "vitest";
import {
  InProcessRuntimeController,
  RuntimeSwitchPendingError,
} from "./runtime-controller.js";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";

function versions(model: string): SettingsConfigVersions {
  return {
    model,
    env: "env",
    search: "search",
    mcp: "mcp",
    agents: "agents",
    skills: "skills",
  };
}

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
    getConfigVersion: (): Promise<SettingsConfigVersions> =>
      Promise.resolve(versions(version)),
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
      getConfigVersion: (): Promise<SettingsConfigVersions> =>
        Promise.resolve(versions(version)),
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
      getConfigVersion: (): Promise<SettingsConfigVersions> =>
        Promise.resolve(versions(version)),
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

it("holds reconnect through tool refresh, rejects leases/background activity, and acknowledges only MCP", async () => {
  let current = versions("A");
  const reasons: string[] = [];
  const created: (readonly string[] | undefined)[] = [];
  const controller = new InProcessRuntimeController({
    clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
    updateStatus: (): Promise<void> => Promise.resolve(),
    publishNotice: vi.fn(),
    getConfigVersion: (): Promise<SettingsConfigVersions> =>
      Promise.resolve(current),
    createRuntime: (domains): Promise<UiRuntimeComposition> => {
      created.push(domains);
      return Promise.resolve({
        getActivityReasons: () => reasons,
        dispose: (): Promise<void> => Promise.resolve(),
      } as unknown as UiRuntimeComposition);
    },
  });
  const lease = await controller.acquireRuntime();
  await expect(
    controller.reconnectMcp(() => Promise.resolve("new")),
  ).rejects.toMatchObject({ code: "INSTANCE_BUSY" });
  lease.release();
  for (const reason of [
    "background subagents",
    "pending tools",
    "background shell jobs",
  ]) {
    reasons.push(reason);
    await expect(
      controller.reconnectMcp(() => Promise.resolve("new")),
    ).rejects.toMatchObject({ code: "INSTANCE_BUSY" });
    reasons.pop();
  }
  current = { ...current, mcp: "new" };
  let entered!: () => void;
  const enteredGate = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reconnect = controller.reconnectMcp(async () => {
    entered();
    await gate;
    return "new";
  });
  await enteredGate;
  let admitted = false;
  const next = controller.acquireRuntime().then((value) => {
    admitted = true;
    return value;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(admitted).toBe(false);
  release();
  await reconnect;
  (await next).release();
  expect(created).toEqual([undefined]);
  current = { ...current, model: "B", mcp: "newer" };
  await controller.reconnectMcp(() => Promise.resolve("newer"));
  (await controller.acquireRuntime()).release();
  expect(created).toEqual([undefined, ["model"]]);
});
it("does not acknowledge failed or newer unapplied MCP versions and releases admission after failure", async () => {
  let current = versions("A");
  const created: (readonly string[] | undefined)[] = [];
  const controller = new InProcessRuntimeController({
    clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
    updateStatus: (): Promise<void> => Promise.resolve(),
    publishNotice: vi.fn(),
    getConfigVersion: (): Promise<SettingsConfigVersions> =>
      Promise.resolve(current),
    createRuntime: (domains): Promise<UiRuntimeComposition> => {
      created.push(domains);
      return Promise.resolve({
        getActivityReasons: () => [],
        dispose: (): Promise<void> => Promise.resolve(),
      } as unknown as UiRuntimeComposition);
    },
  });
  (await controller.acquireRuntime()).release();
  current = { ...current, mcp: "failed-version" };
  await expect(
    controller.reconnectMcp(() =>
      Promise.reject(new Error("tools refresh failed")),
    ),
  ).rejects.toThrow("tools refresh failed");
  (await controller.acquireRuntime()).release();
  expect(created).toEqual([undefined, ["mcp"]]);
  current = { ...current, mcp: "newer-version" };
  await controller.reconnectMcp(() => Promise.resolve("older-applied-version"));
  (await controller.acquireRuntime()).release();
  expect(created).toEqual([undefined, ["mcp"], ["mcp"]]);
});
