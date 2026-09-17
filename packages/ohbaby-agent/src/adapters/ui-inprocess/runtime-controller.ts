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
  readonly coordinateAdmission?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly getConfigVersion?: () => Promise<string>;
  readonly onRuntimeReplaced?: () => void;
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

export class RuntimeSwitchPendingError extends Error {}

export class InProcessRuntimeController {
  private admissionBarrier: Promise<void> = Promise.resolve();
  private admittedWork = 0;
  private closed = false;
  private waitingMessage: string | undefined;

  close(): void {
    this.closed = true;
  }
  private runtimeVersion: string | undefined;

  /** A rejected admission stays in the durable submission queue, outside runtime activity. */
  async acquireRuntime(
    useCurrent = false,
  ): Promise<{ runtime: UiRuntimeComposition; release: () => void }> {
    const previous = this.admissionBarrier;
    let unlock!: () => void;
    this.admissionBarrier = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      for (;;) {
        if (this.closed) throw new Error("Runtime is shutting down");
        // Runtime initialization/disposal may need the configuration lock themselves.
        // Never await those operations while holding publication coordination.
        const runtime = await this.getRuntimeForPrompt();
        const admitted = await this.coordinate(async () => {
          if (this.closed) throw new Error("Runtime is shutting down");
          const version = useCurrent
            ? this.runtimeVersion
            : await this.options.getConfigVersion?.();
          if (this.runtimeVersion !== version) {
            const reasons = [...runtime.getActivityReasons()];
            if (this.admittedWork > 0)
              reasons.unshift("current tasks or context summaries");
            if (reasons.length > 0) {
              const message = `Waiting to switch model: ${reasons.join(", ")}`;
              if (this.waitingMessage !== message)
                this.options.publishNotice({
                  key: "runtime:model-switch",
                  level: "info",
                  title: "Model saved",
                  message,
                });
              this.waitingMessage = message;
              throw new RuntimeSwitchPendingError(message);
            }
            return false;
          }
          this.waitingMessage = undefined;
          this.admittedWork += 1;
          return true;
        });
        if (!admitted) {
          await this.resetRuntime();
          this.options.onRuntimeReplaced?.();
          continue;
        }
        let released = false;
        return {
          runtime,
          release: (): void => {
            if (!released) {
              released = true;
              this.admittedWork -= 1;
            }
          },
        };
      }
    } finally {
      unlock();
    }
  }

  private readonly activeRunSessionById = new Map<string, string>();
  private readonly activeRunBySession = new Map<string, string>();
  private resetBarrier: Promise<void> = Promise.resolve();
  private runtimePromise: Promise<UiRuntimeComposition> | undefined;

  constructor(private readonly options: InProcessRuntimeControllerOptions) {}

  private coordinate<T>(work: () => Promise<T>): Promise<T> {
    return this.options.coordinateAdmission
      ? this.options.coordinateAdmission(work)
      : work();
  }

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
      .then(() =>
        this.coordinate(async () => {
          this.runtimeVersion = await this.options.getConfigVersion?.();
          return this.options.createRuntime();
        }),
      )
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
    } finally {
      await this.options.clearPendingPermissionsForRun(runId);
    }
  }

  async abortPromptRun(runId: string): Promise<boolean> {
    if (!this.activeRunSessionById.has(runId)) {
      return false;
    }
    await this.cancelPromptRun(runId);
    return true;
  }
}
