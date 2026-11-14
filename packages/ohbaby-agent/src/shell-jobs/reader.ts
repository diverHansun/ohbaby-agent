import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import type {
  UiShellJobListQuery,
  UiShellJobList,
  UiShellJobOutput,
  UiShellJobRow,
  UiShellJobTarget,
  UiShellJobLog,
  UiShellJobLogQuery,
} from "ohbaby-sdk";
import {
  SHELL_JOB_STATUSES,
  ShellJobQueryError,
  type ShellJobOwnerFilter,
  type ShellJobPagePosition,
  type ShellJobQueryScope,
} from "./query.js";
import { boundedText } from "./notice.js";
import type { ShellJobRecord, ShellJobStatus, ShellJobStore } from "./store.js";

type WithoutVersion<T> = Omit<
  T,
  "runtimeEpoch" | "revision" | "bindingGeneration"
>;
export class ShellJobReadError extends Error {
  constructor(
    readonly code: "SHELL_JOB_NOT_FOUND" | "SHELL_JOB_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "ShellJobReadError";
  }
}
interface NormalizedList {
  readonly owner?: ShellJobOwnerFilter;
  readonly statuses?: readonly ShellJobStatus[];
  readonly includeFinished?: boolean;
  readonly backgroundOnly?: boolean;
  readonly limit: number;
}
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new ShellJobQueryError(
      `${label} must be a nonempty identifier of at most 256 characters.`,
    );
  return value;
}
function integer(
  value: unknown,
  fallback: number,
  max: number,
  label: string,
  min = 1,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ShellJobQueryError(
      `${label} is outside its supported integer range.`,
    );
  return value;
}
function normalizedList(input: UiShellJobListQuery): NormalizedList {
  const limit = integer(input.limit, 20, 100, "limit");
  let owner: ShellJobOwnerFilter | undefined;
  const ownerInput: unknown = input.owner;
  if (ownerInput !== undefined) {
    if (
      typeof ownerInput !== "object" ||
      ownerInput === null ||
      !("kind" in ownerInput)
    )
      throw new ShellJobQueryError("Invalid task owner filter.");
    const kind = ownerInput.kind;
    if (kind === "main" || kind === "subagents") owner = { kind };
    else if (kind === "subagent" && "subagentId" in ownerInput)
      owner = {
        kind,
        subagentId: requiredId(ownerInput.subagentId, "subagentId"),
      };
    else throw new ShellJobQueryError("Invalid task owner filter.");
  }
  if (
    input.statuses !== undefined &&
    (!Array.isArray(input.statuses) ||
      input.statuses.length > 6 ||
      input.statuses.some(
        (status: unknown) =>
          !SHELL_JOB_STATUSES.some((known) => known === status),
      ))
  )
    throw new ShellJobQueryError("Invalid task status filter.");
  const statuses = input.statuses?.length
    ? [...new Set(input.statuses)].sort()
    : undefined;
  const mode: unknown = input.mode;
  if (mode !== undefined && mode !== "background")
    throw new ShellJobQueryError("Invalid task mode filter.");
  return {
    owner,
    statuses,
    ...(mode === "background" ? { backgroundOnly: true } : {}),
    limit,
  };
}
function fingerprint(
  scope: ShellJobQueryScope,
  filter: Omit<NormalizedList, "limit">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        owner: filter.owner ?? null,
        statuses: filter.statuses ?? [],
        ...(filter.includeFinished === undefined
          ? {}
          : { includeFinished: filter.includeFinished }),
        ...(filter.backgroundOnly ? { backgroundOnly: true } : {}),
      }),
    )
    .digest("hex");
}
export function encodeShellJobCursor(
  scope: ShellJobQueryScope,
  filter: Omit<NormalizedList, "limit">,
  position: ShellJobPagePosition,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, filter: fingerprint(scope, filter), ...position }),
  ).toString("base64url");
}
export function decodeShellJobCursor(
  cursor: string | undefined,
  scope: ShellJobQueryScope,
  filter: Omit<NormalizedList, "limit">,
): ShellJobPagePosition | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (
      typeof cursor !== "string" ||
      cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw new Error("encoding");
    const data: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof data !== "object" ||
      data === null ||
      !("v" in data) ||
      data.v !== 1 ||
      !("filter" in data) ||
      data.filter !== fingerprint(scope, filter) ||
      !("attention" in data) ||
      (data.attention !== 0 && data.attention !== 1) ||
      !("at" in data) ||
      typeof data.at !== "number" ||
      !Number.isSafeInteger(data.at) ||
      data.at < 0 ||
      !("jobId" in data)
    )
      throw new Error("scope");
    return {
      attention: data.attention,
      at: data.at,
      jobId: requiredId(data.jobId, "cursor jobId"),
    };
  } catch {
    throw new ShellJobQueryError(
      "Task cursor does not match this owner and filter, or is malformed.",
    );
  }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
async function openLog(
  path: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  if ((await realpath(path)) !== path)
    throw new Error("Task log path is no longer canonical.");
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Task log is not a regular file.");
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameFile(before, opened) ||
      (await realpath(path)) !== path
    )
      throw new Error("Task log changed while opening.");
    signal?.throwIfAborted();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export type ShellJobPublicSummary = Pick<
  ShellJobRecord,
  | "jobId"
  | "command"
  | "description"
  | "mode"
  | "stopReason"
  | "cleanup"
  | "createdAt"
  | "startedAt"
  | "promotedAt"
  | "endedAt"
  | "resultReadyAt"
  | "settledAt"
  | "timeoutMs"
  | "exitCode"
  | "signal"
  | "trackingReleasedAt"
> & { readonly status: ShellJobStatus };

/** Bounded saved facts shared by the user task view and the model task list; never log content. */
export function shellJobSummary(record: ShellJobRecord): ShellJobPublicSummary {
  if (record.status === null)
    throw new ShellJobReadError(
      "SHELL_JOB_NOT_READY",
      "Task launch registration has not finished.",
    );
  return {
    jobId: record.jobId,
    command: boundedText(record.command, 1024),
    description:
      record.description === null ? null : boundedText(record.description, 512),
    mode: record.mode,
    status: record.status,
    stopReason: record.stopReason,
    cleanup: record.cleanup,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    promotedAt: record.promotedAt,
    endedAt: record.endedAt,
    resultReadyAt: record.resultReadyAt,
    settledAt: record.settledAt,
    timeoutMs: record.timeoutMs,
    exitCode: record.exitCode,
    signal: record.signal,
    trackingReleasedAt: record.trackingReleasedAt,
  };
}

/** Authorized backend reads. The caller owns client/root authorization; no method accepts a filesystem path. */
export class ShellJobReader {
  constructor(
    private readonly options: {
      readonly store: ShellJobStore;
      readonly refreshRoot?: (rootSessionId: string) => Promise<void>;
      readonly readCurrent?: (row: ShellJobRecord) => {
        readonly record: ShellJobRecord;
        readonly source: "live" | "saved";
        readonly sampledAt: number;
      };
      readonly ownerName?: (row: ShellJobRecord) => Promise<string>;
      readonly management: (row: ShellJobRecord) => Promise<{
        readonly managedByCurrentBackend: boolean;
        readonly canStop: boolean;
      }>;
    },
  ) {}
  private owned(input: UiShellJobTarget): ShellJobRecord {
    const root = requiredId(input.rootSessionId, "rootSessionId");
    const row = this.options.store.get(requiredId(input.jobId, "jobId"));
    if (row?.rootSessionId !== root)
      throw new ShellJobReadError(
        "SHELL_JOB_NOT_FOUND",
        "Task was not found in this session tree.",
      );
    return row;
  }
  private management(
    record: ShellJobRecord,
  ): ReturnType<typeof this.options.management> {
    return this.options.management(record);
  }
  async row(
    record: ShellJobRecord,
    managementResult?: ReturnType<ShellJobReader["management"]>,
  ): Promise<UiShellJobRow> {
    const summary = shellJobSummary(record);
    const management = await (managementResult ?? this.management(record));
    return {
      rootSessionId: record.rootSessionId,
      sessionId: record.sessionId,
      ownerKind: record.contextScopeId === null ? "main" : "subagent",
      ...management,
      ownerName: boundedText(
        (await this.options.ownerName?.(record)) ??
          (record.contextScopeId === null
            ? "Main agent"
            : `Subagent ${record.contextScopeId}`),
        256,
      ),
      ...(record.contextScopeId === null
        ? {}
        : {
            subagentId: record.contextScopeId,
            ...(record.runId ? { childRunId: record.runId } : {}),
          }),
      ...summary,
    };
  }
  async list(
    input: UiShellJobListQuery,
    captureVersion?: () => void,
  ): Promise<WithoutVersion<UiShellJobList>> {
    const rootSessionId = requiredId(input.rootSessionId, "rootSessionId");
    const filter = normalizedList(input);
    const scope = { rootSessionId };
    const before = decodeShellJobCursor(input.cursor, scope, filter);
    input.signal?.throwIfAborted();
    await this.options.refreshRoot?.(rootSessionId);
    input.signal?.throwIfAborted();
    captureVersion?.();
    const page = this.options.store.query({ scope, ...filter, before });
    // Share only equivalent running-owner checks within this page; every later
    // query and each control operation revalidates independently.
    const owners = new Map<string, ReturnType<ShellJobReader["management"]>>();
    const rows = await Promise.all(
      page.rows.map((record) => {
        if (record.status !== "running" || record.trackingReleasedAt !== null)
          return this.row(record);
        const key = JSON.stringify([
          record.ownerId,
          record.ownerPid,
          record.ownerStartToken,
        ]);
        let result = owners.get(key);
        if (!result) {
          result = this.management(record);
          owners.set(key, result);
        }
        return this.row(record, result);
      }),
    );
    input.signal?.throwIfAborted();
    return {
      rootSessionId,
      rows,
      hasMore: page.hasMore,
      ...(page.next
        ? { nextCursor: encodeShellJobCursor(scope, filter, page.next) }
        : {}),
      pendingStartCount: page.pendingStartCount,
      filteredCount: page.filteredCount,
      statusCounts: page.statusCounts,
      unconfirmedCount: page.unconfirmedCount,
    };
  }
  async output(
    input: UiShellJobTarget,
  ): Promise<WithoutVersion<UiShellJobOutput>> {
    this.owned(input);
    input.signal?.throwIfAborted();
    const saved = this.owned(input);
    const current = this.options.readCurrent?.(saved) ?? {
      record: saved,
      source: "saved" as const,
      sampledAt: Date.now(),
    };
    const record = current.record;
    let logAvailable = false;
    let logError: string | undefined;
    if (record.outputPath) {
      try {
        const handle = await openLog(record.outputPath, input.signal);
        await handle.close();
        logAvailable = true;
      } catch (error) {
        input.signal?.throwIfAborted();
        logError =
          error instanceof Error
            ? error.message
            : "Task log could not be read.";
      }
    } else logError = "No task log is available.";
    const job = await this.row(record);
    // Metadata lookup can yield too; revalidate after the last asynchronous projection.
    if (this.owned(input).outputPath !== saved.outputPath)
      throw new ShellJobReadError(
        "SHELL_JOB_NOT_READY",
        "Task log binding changed; read again.",
      );
    input.signal?.throwIfAborted();
    return {
      rootSessionId: input.rootSessionId,
      job,
      source: current.source,
      sampledAt: current.sampledAt,
      output:
        record.mode === "background"
          ? boundedText(record.outputTail ?? "", 32768, true)
          : "",
      tailAvailable: record.mode === "background" && record.outputTail !== null,
      outputBytes: record.outputBytes,
      outputComplete: record.outputComplete,
      outputCheckpointAt: record.outputCheckpointAt,
      outputTruncated: record.outputTruncated,
      logAvailable,
      ...(logAvailable && record.outputPath
        ? { logPath: record.outputPath }
        : {}),
      ...(logError ? { logError } : {}),
    };
  }
  async log(input: UiShellJobLogQuery): Promise<WithoutVersion<UiShellJobLog>> {
    const record = this.owned(input);
    const offset = integer(
      input.offset,
      0,
      Number.MAX_SAFE_INTEGER - 65536,
      "offset",
      0,
    );
    const maxBytes = integer(input.maxBytes, 32768, 65536, "maxBytes");
    const base = {
      rootSessionId: input.rootSessionId,
      jobId: record.jobId,
      encoding: "utf-8" as const,
      offset,
      truncated: record.outputTruncated,
      outputComplete: record.outputComplete,
    };
    let handle: FileHandle | undefined;
    try {
      input.signal?.throwIfAborted();
      if (!record.outputPath) throw new Error("No task log is available.");
      handle = await openLog(record.outputPath, input.signal);
      const opened = await handle.stat({ bigint: true });
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
      const after = await lstat(record.outputPath, { bigint: true });
      if (
        !after.isFile() ||
        !sameFile(opened, after) ||
        (await realpath(record.outputPath)) !== record.outputPath
      )
        throw new Error("Task log changed during reading.");
      if (this.owned(input).outputPath !== record.outputPath)
        throw new ShellJobReadError(
          "SHELL_JOB_NOT_READY",
          "Task log binding changed; read again.",
        );
      input.signal?.throwIfAborted();
      const nextOffset = offset + bytesRead;
      return {
        ...base,
        available: true,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        bytesRead,
        nextOffset,
        hasMore: BigInt(nextOffset) < after.size,
      };
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof ShellJobReadError) throw error;
      return {
        ...base,
        available: false,
        text: "",
        bytesRead: 0,
        nextOffset: offset,
        hasMore: false,
        error:
          error instanceof Error
            ? error.message
            : "Task log could not be read.",
      };
    } finally {
      await handle?.close();
    }
  }
}
