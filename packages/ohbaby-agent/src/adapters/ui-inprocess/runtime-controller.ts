import type { UiRunStatus } from "ohbaby-sdk";
import {
  startRunStreamProjection,
  type RunStreamProjection,
  type RunStreamProjectionOptions,
} from "../ui-runtime/run-stream-adapter.js";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";
import type { NoticeDraft } from "./types.js";

export type { RunStreamProjection };

export interface InProcessRuntimeControllerOptions {
  readonly clearPendingPermissionsForRun: (runId: string) => Promise<void>;
  readonly createRuntime: () => Promise<UiRuntimeComposition>;
  readonly publishNotice: (notice: NoticeDraft) => void;
  readonly updateStatus: (status: UiRunStatus) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class InProcessRuntimeController {
  private activeRunId: string | undefined;
  private resetBarrier: Promise<void> = Promise.resolve();
  private runtimePromise: Promise<UiRuntimeComposition> | undefined;

  constructor(private readonly options: InProcessRuntimeControllerOptions) {}

  getActiveRunId(): string | undefined {
    return this.activeRunId;
  }

  setActiveRunId(runId: string): void {
    this.activeRunId = runId;
  }

  clearActiveRunId(): void {
    this.activeRunId = undefined;
  }

  isActiveRun(runId: string): boolean {
    return this.activeRunId === runId;
  }

  getRuntime(): Promise<UiRuntimeComposition> {
    if (this.runtimePromise) {
      return this.runtimePromise;
    }
    const creation = this.resetBarrier
      .then(() => this.options.createRuntime())
      .catch((error: unknown) => {
        if (this.runtimePromise === creation) {
          this.runtimePromise = undefined;
        }
        throw error;
      });
    this.runtimePromise = creation;
    return creation;
  }

  getRuntimeIfStarted(): Promise<UiRuntimeComposition> | undefined {
    return this.runtimePromise;
  }

  resetRuntime(): Promise<void> {
    const runtimePromise = this.runtimePromise;
    this.runtimePromise = undefined;
    const operation = this.resetBarrier.then(async () => {
      if (!runtimePromise) {
        return;
      }
      const runtime = await runtimePromise;
      await runtime.dispose();
    });
    this.resetBarrier = operation.catch(() => undefined);
    return operation;
  }

  async getRuntimeForPrompt(): Promise<UiRuntimeComposition> {
    try {
      return await this.getRuntime();
    } catch (error) {
      const message = getErrorMessage(error);
      await this.options.updateStatus({
        kind: "error",
        message,
        recoverable: true,
      });
      this.options.publishNotice({
        key: `runtime:${message}`,
        level: "error",
        message,
        title: "Runtime error",
      });
      throw error;
    }
  }

  startRunStreamProjection(
    options: RunStreamProjectionOptions,
  ): RunStreamProjection {
    return startRunStreamProjection(options);
  }

  async cancelPromptRun(runId: string): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      runtime.cancel(runId, "run aborted");
    } catch {
      // Abort is best-effort; the run may already have completed.
    } finally {
      await this.options.clearPendingPermissionsForRun(runId);
    }
  }

  async abortPromptRun(runId?: string): Promise<boolean> {
    const targetRunId = runId ?? this.activeRunId;
    if (!targetRunId || targetRunId !== this.activeRunId) {
      return false;
    }
    await this.cancelPromptRun(targetRunId);
    return true;
  }
}
