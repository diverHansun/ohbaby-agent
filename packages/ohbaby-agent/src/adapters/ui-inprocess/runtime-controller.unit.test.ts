import type { UiRunStatus } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";
import { InProcessRuntimeController } from "./runtime-controller.js";
import type { NoticeDraft } from "./types.js";

function runtime(input: {
  readonly cancel?: (runId: string, reason?: string) => void;
} = {}): UiRuntimeComposition {
  return {
    cancel: input.cancel ?? ((): void => undefined),
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
    const cancelled: { readonly reason?: string; readonly runId: string }[] = [];
    const cleared: string[] = [];
    const controller = new InProcessRuntimeController({
      clearPendingPermissionsForRun: (runId): Promise<void> => {
        cleared.push(runId);
        return Promise.resolve();
      },
      createRuntime: (): Promise<UiRuntimeComposition> =>
        Promise.resolve(
          runtime({
            cancel(runId, reason): void {
              cancelled.push({ reason, runId });
            },
          }),
        ),
      publishNotice: (): void => undefined,
      updateStatus: (): Promise<void> => Promise.resolve(),
    });
    controller.setActiveRunId("run_active");

    await expect(controller.abortPromptRun("run_other")).resolves.toBe(false);
    await expect(controller.abortPromptRun("run_active")).resolves.toBe(true);

    expect(cancelled).toEqual([
      { reason: "run aborted", runId: "run_active" },
    ]);
    expect(cleared).toEqual(["run_active"]);
  });
});
