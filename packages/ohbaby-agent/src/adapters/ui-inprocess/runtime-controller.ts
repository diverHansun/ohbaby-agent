import type {
  ShutdownOptions,
  CleanupTaskResult,
} from "../../runtime/shutdown.js";
import type { UiRunStatus } from "ohbaby-sdk";
import {
  startRunStreamProjection,
  type RunStreamProjection,
  type RunStreamProjectionOptions,
} from "../ui-runtime/run-stream-adapter.js";
import type { UiRuntimeComposition } from "../ui-runtime/types.js";
import type { NoticeDraft } from "./types.js";
import type {
  SettingsConfigVersions,
  SettingsDomain,
} from "../../config/llm/config-coordination.js";

export type { RunStreamProjection };

export interface InProcessRuntimeControllerOptions {
  readonly clearPendingPermissionsForRun: (runId: string) => Promise<void>;
  readonly coordinateAdmission?: <T>(work: () => Promise<T>) => Promise<T>;
  readonly getConfigVersion?: () => Promise<SettingsConfigVersions>;
  readonly onRuntimeReplaced?: () => void;
  /** Reloads configuration that must match the recorded settings version. Runs under coordination. */
  readonly prepareRuntime?: (
    changedDomains?: readonly SettingsDomain[],
  ) => Promise<void>;
  /** Assembles the runtime outside coordination, so slow external connections cannot block other work. */
  readonly createRuntime: (
    changedDomains?: readonly SettingsDomain[],
  ) => Promise<UiRuntimeComposition>;
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

export class InstanceBusyError extends Error {
  readonly code = "INSTANCE_BUSY";
  constructor() {
    super("Instance has active work");
  }
}

export class InProcessRuntimeController {
  private admissionBarrier: Promise<void> = Promise.resolve();
  private admittedWork = 0;
  private closed = false;
  private waitingMessage: string | undefined;

  close(): void {
    this.closed = true;
    this.resolvedRuntime?.closeAdmission?.();
  }
  private runtimeVersion: SettingsConfigVersions | undefined;

  private changedDomains(
    version: SettingsConfigVersions | undefined,
  ): SettingsDomain[] {
    return (Object.keys(version ?? {}) as SettingsDomain[]).filter(
      (domain) =>
        domain !== "model" &&
        this.runtimeVersion?.[domain] !== version?.[domain],
    );
  }

  /** A rejected admission stays in the durable submission queue, outside runtime activity. */
  async acquireRuntime(): Promise<{
    runtime: UiRuntimeComposition;
    release: () => void;
  }> {
    const previous = this.admissionBarrier;
    let unlock!: () => void;
    this.admissionBarrier = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      for (;;) {
        if (this.isClosed()) throw new Error("Runtime is shutting down");
        // Runtime initialization/disposal may need the configuration lock themselves.
        // Never await those operations while holding publication coordination.
        const runtime = await this.getRuntimeForPrompt();
        const admitted = await this.coordinate(async () => {
          if (this.isClosed()) throw new Error("Runtime is shutting down");
          const version = await this.options.getConfigVersion?.();
          if (this.changedDomains(version).length > 0) {
            const reasons = [...runtime.getActivityReasons()];
            if (this.admittedWork > 0)
              reasons.unshift("current tasks or context summaries");
            if (reasons.length > 0) {
              const message = `Waiting to apply settings: ${reasons.join(", ")}`;
              if (this.waitingMessage !== message)
                this.options.publishNotice({
                  key: "runtime:model-switch",
                  level: "info",
                  title: "Settings saved",
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

  /** Explicit reconnect shares prompt admission, without acquiring its own work lease. */
  async reconnectMcp(reload: () => Promise<string>): Promise<void> {
    const previous = this.admissionBarrier;
    let unlock!: () => void;
    this.admissionBarrier = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      if (this.isClosed()) throw new Error("Runtime is shutting down");
      // An in-flight initialization can itself require publication coordination.
      const runtime = await this.runtimePromise;
      // The admission barrier keeps new rounds out; MCP connections must not hold
      // the process-wide settings coordination shared by every workspace.
      if (
        this.admittedWork > 0 ||
        (runtime?.getActivityReasons().length ?? 0) > 0
      )
        throw new InstanceBusyError();
      const mcp = await reload();
      if (this.runtimeVersion !== undefined)
        this.runtimeVersion = { ...this.runtimeVersion, mcp };
    } finally {
      unlock();
    }
  }

  private readonly activeRunSessionById = new Map<string, string>();
  private readonly activeRunBySession = new Map<string, string>();
  private resetBarrier: Promise<void> = Promise.resolve();
  private runtimePromise: Promise<UiRuntimeComposition> | undefined;
  private resolvedRuntime: UiRuntimeComposition | undefined;

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

  private isClosed(): boolean {
    return this.closed;
  }

  getRuntime(): Promise<UiRuntimeComposition> {
    if (this.closed)
      return Promise.reject(new Error("Runtime is shutting down"));
    if (this.runtimePromise) {
      return this.runtimePromise;
    }
    const creation = this.resetBarrier
      .then(async () => {
        // Snapshot the version and reload the configuration it describes together.
        // A later edit only makes the recorded version older, which rebuilds again.
        const { version, changed } = await this.coordinate(async () => {
          if (this.isClosed()) throw new Error("Runtime is shutting down");
          const version = await this.options.getConfigVersion?.();
          const changed =
            this.runtimeVersion === undefined
              ? undefined
              : this.changedDomains(version);
          await this.options.prepareRuntime?.(changed);
          return { version, changed };
        });
        if (this.isClosed()) throw new Error("Runtime is shutting down");
        const runtime = await this.options.createRuntime(changed);
        this.runtimeVersion = version;
        this.resolvedRuntime = runtime;
        if (this.isClosed()) runtime.closeAdmission?.();
        return runtime;
      })
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

  resetRuntime(shutdown?: ShutdownOptions): Promise<CleanupTaskResult> {
    const runtimePromise = this.runtimePromise;
    this.runtimePromise = undefined;
    const operation = this.resetBarrier.then(async () => {
      if (!runtimePromise) {
        return;
      }
      const runtime = await runtimePromise;
      const result = await runtime.dispose(shutdown);
      if (this.resolvedRuntime === runtime) this.resolvedRuntime = undefined;
      return result;
    });
    this.resetBarrier = operation.then(
      () => undefined,
      () => undefined,
    );
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
      await runtime.interruptRunTree(runId, "user-stop");
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
