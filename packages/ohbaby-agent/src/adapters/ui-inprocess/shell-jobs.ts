import type {
  UiShellJobListQuery,
  UiShellJobList,
  UiShellJobQuery,
  UiShellJobTarget,
  UiShellJobOutput,
  UiShellJobLogQuery,
  UiShellJobLog,
  UiShellJobStopResult,
  UiShellJobAbandonInput,
  UiShellJobAbandonResult,
  UiShellJobVersion,
  UiShellJobsInvalidatedEvent,
} from "ohbaby-sdk";
import {
  ShellJobReadError,
  type ShellJobReader,
} from "../../shell-jobs/reader.js";
import { ShellJobQueryError } from "../../shell-jobs/query.js";
import type { ShellJobRecord, ShellJobStore } from "../../shell-jobs/store.js";

/** Backend projection only; snapshots stay authoritative and queries never start model runs. */
export class ShellJobProjection {
  private sequence = 0;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly runtimeEpoch: string;
      readonly store: ShellJobStore;
      readonly reader: ShellJobReader;
      readonly validateRoot: (input: UiShellJobQuery) => Promise<void>;
      readonly readCurrent?: (record: ShellJobRecord) => ShellJobRecord;
      readonly stop: (
        rootSessionId: string,
        jobId: string,
        beforeAccept?: () => void,
      ) => Promise<{ readonly outcome: "accepted" | "already-terminal" }>;
      readonly abandon: (
        rootSessionId: string,
        jobId: string,
        confirm: true,
        beforeAccept?: () => void,
      ) => Promise<unknown>;
      readonly publish: (event: UiShellJobsInvalidatedEvent) => void;
    },
  ) {
    this.unsubscribe = options.store.subscribe((record) => {
      this.invalidate(record.rootSessionId);
    });
  }

  private invalidate(rootSessionId: string): void {
    if (this.disposed) return;
    const revision = ++this.sequence;
    this.options.publish({
      type: "shell-jobs.invalidated",
      rootSessionId,
      runtimeEpoch: this.options.runtimeEpoch,
      revision,
    });
  }
  private version(input: UiShellJobQuery): UiShellJobVersion {
    // A foreign backend can update the database without this store's subscription.
    // Advance on each authoritative read, before async facts are captured, without emitting a refresh loop.
    const revision = ++this.sequence;
    return {
      rootSessionId: input.rootSessionId,
      runtimeEpoch: this.options.runtimeEpoch,
      revision,
      ...(input.bindingGeneration === undefined
        ? {}
        : { bindingGeneration: input.bindingGeneration }),
    };
  }
  private async validate(input: UiShellJobQuery): Promise<void> {
    this.assertOpen();
    input.signal?.throwIfAborted();
    await this.options.validateRoot(input);
    this.assertOpen();
    input.signal?.throwIfAborted();
  }
  private assertOpen(): void {
    if (this.disposed) throw new Error("Shell job projection disposed");
  }
  private record(input: UiShellJobTarget): ShellJobRecord {
    const record = this.options.store.get(input.jobId);
    if (record?.rootSessionId !== input.rootSessionId)
      throw new ShellJobReadError(
        "SHELL_JOB_NOT_FOUND",
        "Task was not found in this session tree.",
      );
    return this.options.readCurrent?.(record) ?? record;
  }
  async list(input: UiShellJobListQuery): Promise<UiShellJobList> {
    await this.validate(input);
    let version: UiShellJobVersion | undefined;
    const page = await this.options.reader.list(input, () => {
      version = this.version(input);
    });
    if (!version)
      throw new Error("Shell job query did not capture a snapshot version.");
    await this.validate(input);
    return { ...page, ...version };
  }
  async output(input: UiShellJobTarget): Promise<UiShellJobOutput> {
    await this.validate(input);
    const version = this.version(input);
    const output = await this.options.reader.output(input);
    await this.validate(input);
    return { ...output, ...version };
  }
  async log(input: UiShellJobLogQuery): Promise<UiShellJobLog> {
    await this.validate(input);
    const version = this.version(input);
    const log = await this.options.reader.log(input);
    await this.validate(input);
    return { ...log, ...version };
  }
  async stop(
    input: UiShellJobTarget,
    beforeAccept?: () => void,
  ): Promise<UiShellJobStopResult> {
    await this.validate(input);
    const before = this.record(input);
    if (before.status === null)
      throw new ShellJobReadError(
        "SHELL_JOB_NOT_READY",
        "Task launch registration has not finished.",
      );
    const outcome =
      before.trackingReleasedAt !== null
        ? "already-terminal"
        : (
            await this.options.stop(
              input.rootSessionId,
              input.jobId,
              beforeAccept,
            )
          ).outcome;
    const version = this.version(input);
    const job = await this.options.reader.row(this.record(input));
    await this.validate(input);
    this.record(input);
    return {
      ...version,
      outcome,
      job,
    };
  }
  async abandon(
    input: UiShellJobAbandonInput,
    beforeAccept?: () => void,
  ): Promise<UiShellJobAbandonResult> {
    const confirmation: unknown = input.confirm;
    if (confirmation !== true)
      throw new ShellJobQueryError(
        "Abandoning task tracking requires confirm=true.",
      );
    await this.validate(input);
    this.record(input);
    await this.options.abandon(
      input.rootSessionId,
      input.jobId,
      true,
      beforeAccept,
    );
    const version = this.version(input);
    const record = this.record(input);
    if (record.trackingReleasedAt === null)
      throw new Error("Task tracking release was not persisted.");
    const job = await this.options.reader.row(record);
    await this.validate(input);
    this.record(input);
    return { ...version, trackingReleasedAt: record.trackingReleasedAt, job };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
}
