import type { UiRunStatus } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";
import { InProcessRuntimeController } from "./runtime-controller.js";
import type { NoticeDraft } from "./types.js";

function runtime(
  input: {
    readonly dispose?: () => Promise<void>;
    readonly interruptRunTree?: (
      runId: string,
      reason?: string,
    ) => Promise<void>;
  } = {},
): UiRuntimeComposition {
  return {
    dispose: input.dispose ?? ((): Promise<void> => Promise.resolve()),
    interruptRunTree:
      input.interruptRunTree ?? ((): Promise<void> => Promise.resolve()),
  } as UiRuntimeComposition;
}

describe("InProcessRuntimeController", () => {
  it("creates the runtime lazily once", async (): Promise<void> => {
    let createCount = 0;
    const createdRuntime = runtime();
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      createRuntime: (): Promise<UiRuntimeComposition> => {
        createCount += 1;
        return Promise.resolve(createdRuntime);
      },
      publishNotice: (): void => undefined,
      updateStatus: (): Promise<void> => Promise.resolve(),
    });

    await expect(controller.getRuntime()).resolves.toBe(createdRuntime);
    await expect(controller.getRuntime()).resolves.toBe(createdRuntime);

    expect(createCount).toBe(1);
  });

  it("updates status and publishes a notice when runtime creation fails for a prompt", async (): Promise<void> => {
    const statuses: UiRunStatus[] = [];
    const notices: NoticeDraft[] = [];
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      createRuntime: (): Promise<UiRuntimeComposition> =>
        Promise.reject(new Error("model missing")),
      publishNotice: (notice): void => {
        notices.push(notice);
      },
      updateStatus: (status): Promise<void> => {
        statuses.push(status);
        return Promise.resolve();
      },
    });

    await expect(controller.getRuntimeForPrompt()).rejects.toThrow(
      "model missing",
    );

    expect(statuses).toEqual([
      { kind: "error", message: "model missing", recoverable: true },
    ]);
    expect(notices).toEqual([
      {
        key: "runtime:model missing",
        level: "error",
        message: "model missing",
        title: "Runtime error",
      },
    ]);
  });

  it("only aborts the local active run", async (): Promise<void> => {
    const cancelled: { readonly reason?: string; readonly runId: string }[] =
      [];
    const cleared: string[] = [];
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (runId): Promise<void> => {
        cleared.push(runId);
        return Promise.resolve();
      },
      createRuntime: (): Promise<UiRuntimeComposition> =>
        Promise.resolve(
          runtime({
            interruptRunTree(runId, reason): Promise<void> {
              cancelled.push({ reason, runId });
              return Promise.resolve();
            },
          }),
        ),
      publishNotice: (): void => undefined,
      updateStatus: (): Promise<void> => Promise.resolve(),
    });
    controller.setActiveRunId("run_active");

    await expect(controller.abortPromptRun("run_other")).resolves.toBe(false);
    await expect(controller.abortPromptRun("run_active")).resolves.toBe(true);

    expect(cancelled).toEqual([{ reason: "run aborted", runId: "run_active" }]);
    expect(cleared).toEqual(["run_active"]);
  });

  it("disposes the old runtime before creating a replacement", async (): Promise<void> => {
    const disposed: string[] = [];
    let createCount = 0;
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      createRuntime: (): Promise<UiRuntimeComposition> => {
        createCount += 1;
        const id = `runtime_${String(createCount)}`;
        return Promise.resolve(
          runtime({
            dispose(): Promise<void> {
              disposed.push(id);
              return Promise.resolve();
            },
          }),
        );
      },
      publishNotice: (): void => undefined,
      updateStatus: (): Promise<void> => Promise.resolve(),
    });

    const first = await controller.getRuntime();
    await controller.resetRuntime();
    const second = await controller.getRuntime();

    expect(first).not.toBe(second);
    expect(disposed).toEqual(["runtime_1"]);
    expect(createCount).toBe(2);
  });

  it("blocks replacement creation until the old runtime finishes disposing", async (): Promise<void> => {
    let finishDispose!: () => void;
    const disposing = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    let createCount = 0;
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (): Promise<void> => Promise.resolve(),
      createRuntime: (): Promise<UiRuntimeComposition> => {
        createCount += 1;
        return Promise.resolve(
          runtime({
            dispose: () => (createCount === 1 ? disposing : Promise.resolve()),
          }),
        );
      },
      publishNotice: (): void => undefined,
      updateStatus: (): Promise<void> => Promise.resolve(),
    });

    await controller.getRuntime();
    const reset = controller.resetRuntime();
    const replacement = controller.getRuntime();
    await Promise.resolve();

    expect(createCount).toBe(1);
    finishDispose();
    await reset;
    await replacement;
    expect(createCount).toBe(2);
  });
});
