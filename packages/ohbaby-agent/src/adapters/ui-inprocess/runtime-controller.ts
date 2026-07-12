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
  private readonly activeRunSessionById = new Map<string, string>();
  private readonly activeRunBySession = new Map<string, string>();
  private resetBarrier: Promise<void> = Promise.resolve();
  private runtimePromise: Promise<UiRuntimeComposition> | undefined;

  constructor(private readonly options: InProcessRuntimeControllerOptions) {}

  getActiveRunId(sessionId?: string): string | undefined {
    if (sessionId !== undefined) {
      return this.activeRunBySession.get(sessionId);
    }
    return this.activeRunSessionById.size === 1
      ? this.activeRunSessionById.keys().next().value
      : undefined;
  }

  activeRunIds(): readonly string[] {
    return [...this.activeRunSessionById.keys()];
  }

  setActiveRunId(runId: string, sessionId: string): void {
    const existing = this.activeRunBySession.get(sessionId);
    if (existing && existing !== runId) {
      throw new Error(
        `Session ${sessionId} already has active run ${existing}`,
      );
    }
    this.activeRunBySession.set(sessionId, runId);
    this.activeRunSessionById.set(runId, sessionId);
  }

  clearActiveRunId(runId: string): void {
    const sessionId = this.activeRunSessionById.get(runId);
    if (!sessionId) {
      return;
    }
    this.activeRunSessionById.delete(runId);
    if (this.activeRunBySession.get(sessionId) === runId) {
      this.activeRunBySession.delete(sessionId);
    }
  }

  isActiveRun(runId: string): boolean {
    return this.activeRunSessionById.has(runId);
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
      await runtime.interruptRunTree(runId, "run aborted");
    } catch {
      // Abort is best-effort; the run may already have completed.
    } finally {
      await this.options.clearPendingPermissionsForRun(runId);
    }
  }

  async abortPromptRun(runId?: string): Promise<boolean> {
    const targetRunId = runId ?? this.getActiveRunId();
    if (!targetRunId || !this.activeRunSessionById.has(targetRunId)) {
      return false;
    }
    await this.cancelPromptRun(targetRunId);
    return true;
  }
}
