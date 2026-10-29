import type {
  UiSubagentInstance,
  UiSubagentInstanceQuery,
  UiSubagentInstanceSnapshot,
  UiSubagentInstancesInvalidatedEvent,
  UiSubagentStopInput,
  UiSubagentStopResult,
} from "ohbaby-sdk";
import type {
  SubagentInstanceStore,
  SubagentStatusResult,
  SubagentStopResult,
} from "../../agents/subagents/types.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";

function nonEmpty(value?: string): string | undefined {
  const text = value?.trim();
  return text === "" ? undefined : text;
}

export function subagentAccessError(
  code: "SUBAGENT_CLOSED" | "SUBAGENT_NOT_FOUND",
): Error & { readonly code: string } {
  return Object.assign(
    new Error(
      code === "SUBAGENT_CLOSED"
        ? "Subagent instance is closed"
        : "Subagent instance does not belong to this session",
    ),
    { code },
  );
}

/** Complete instance snapshots; execution history remains a separate, paged API. */
export class SubagentInstanceProjection {
  private readonly revisions = new Map<string, number>();
  private readonly rootsByChild = new Map<string, string>();
  private readonly unsubscribe: readonly (() => void)[];
  private disposed = false;

  constructor(
    private readonly options: {
      readonly runtimeEpoch: string;
      readonly instances: SubagentInstanceStore;
      readonly executions: SubagentExecutionStore;
      readonly validateRoot: (input: UiSubagentInstanceQuery) => Promise<void>;
      readonly runtime: (
        rootSessionId: string,
      ) => Promise<SubagentStatusResult | undefined>;
      readonly stop: (
        input: UiSubagentStopInput,
      ) => Promise<SubagentStopResult | undefined>;
      readonly unprocessedCount: (
        execution: SubagentExecutionRecord,
      ) => Promise<number>;
      readonly publish: (event: UiSubagentInstancesInvalidatedEvent) => void;
    },
  ) {
    this.unsubscribe = [
      options.instances.subscribe((record) => {
        if (this.revisions.has(record.parentSessionId))
          this.rootsByChild.set(record.sessionId, record.parentSessionId);
        this.invalidate(record.parentSessionId);
      }),
      options.executions.subscribe((record) => {
        if (record.childSessionId && this.revisions.has(record.rootSessionId))
          this.rootsByChild.set(record.childSessionId, record.rootSessionId);
        this.invalidate(record.rootSessionId);
      }),
    ];
  }

  invalidate(rootSessionId: string): void {
    if (this.disposed) return;
    const previous = this.revisions.get(rootSessionId);
    const revision = (previous ?? 0) + 1;
    // No cached snapshot exists before the first read or after session removal.
    if (previous !== undefined) this.revisions.set(rootSessionId, revision);
    this.options.publish({
      type: "subagent.instances.invalidated",
      rootSessionId,
      runtimeEpoch: this.options.runtimeEpoch,
      revision,
    });
  }

  remove(rootSessionId: string): void {
    this.revisions.delete(rootSessionId);
    for (const [child, root] of this.rootsByChild)
      if (root === rootSessionId) this.rootsByChild.delete(child);
  }

  invalidateSession(childSessionId: string): void {
    const rootSessionId = this.rootsByChild.get(childSessionId);
    if (rootSessionId) this.invalidate(rootSessionId);
  }

  private revision(rootSessionId: string): number {
    const revision = this.revisions.get(rootSessionId) ?? 1;
    this.revisions.set(rootSessionId, revision);
    return revision;
  }

  async list(
    input: UiSubagentInstanceQuery,
  ): Promise<UiSubagentInstanceSnapshot> {
    if (this.disposed) throw new Error("Subagent instance reader disposed");
    input.signal?.throwIfAborted();
    await this.options.validateRoot(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision(input.rootSessionId);
      const saved = await this.options.instances.listByParent(
        input.rootSessionId,
      );
      // Install input ownership before runtime facts can be captured and then await.
      for (const item of saved)
        this.rootsByChild.set(item.sessionId, input.rootSessionId);
      const runtime = await this.options.runtime(input.rootSessionId);
      const records = runtime?.items ?? saved;
      const instances = await Promise.all(
        records
          .filter((item) => item.closedAt === undefined)
          .map(async (item): Promise<UiSubagentInstance> => {
            if (item.parentSessionId !== input.rootSessionId)
              throw subagentAccessError("SUBAGENT_NOT_FOUND");
            this.rootsByChild.set(item.sessionId, input.rootSessionId);
            const execution =
              runtime?.executions.find(
                (entry) => entry.subagentId === item.subagentId,
              ) ??
              (
                await this.options.executions.list({
                  rootSessionId: input.rootSessionId,
                  subagentId: item.subagentId,
                  limit: 1,
                })
              ).at(0);
            const state = runtime?.runtime?.find(
              (entry) => entry.subagentId === item.subagentId,
            );
            const active =
              execution &&
              (execution.status === "queued" || execution.status === "running");
            return {
              rootSessionId: input.rootSessionId,
              subagentId: item.subagentId,
              displayName:
                nonEmpty(item.name) ?? nonEmpty(item.description) ?? "Subagent",
              description:
                nonEmpty(item.description) ??
                (execution?.prompt ?? item.initialPrompt)
                  .replace(/\s+/gu, " ")
                  .slice(0, 240),
              createdAt: item.createdAt,
              updatedAt: Math.max(item.updatedAt, execution?.updatedAt ?? 0),
              status: item.status,
              currentExecutionId: state
                ? state.executionId
                : active
                  ? execution.executionId
                  : undefined,
              latestExecutionId: execution?.executionId,
              mode: execution?.mode,
              approvalBlocked:
                runtime?.facts?.find(
                  (fact) => fact.subagentId === item.subagentId,
                )?.approval.blocked ?? false,
              settling: state?.settling ?? false,
              unprocessedMessageCount:
                state?.unprocessedMessages.length ??
                (execution
                  ? await this.options.unprocessedCount(execution)
                  : 0),
            };
          }),
      );
      await this.options.validateRoot(input);
      input.signal?.throwIfAborted();
      if (revision !== this.revision(input.rootSessionId)) continue;
      return {
        rootSessionId: input.rootSessionId,
        runtimeEpoch: this.options.runtimeEpoch,
        bindingGeneration: input.bindingGeneration,
        revision,
        complete: true,
        instances,
      };
    }
    throw Object.assign(
      new Error(
        "Subagent instances changed during the read; retry the complete snapshot",
      ),
      { code: "SUBAGENT_SNAPSHOT_CHANGED" },
    );
  }

  async stop(input: UiSubagentStopInput): Promise<UiSubagentStopResult> {
    if (
      typeof input.expectedExecutionId !== "string" ||
      !input.expectedExecutionId.trim()
    )
      throw Object.assign(
        new Error("Expected execution identity is required"),
        { code: "INVALID_SESSION_QUERY" },
      );
    await this.options.validateRoot(input);
    const record = await this.options.instances.get({
      parentSessionId: input.rootSessionId,
      subagentId: input.subagentId,
    });
    if (record?.parentSessionId !== input.rootSessionId)
      throw subagentAccessError("SUBAGENT_NOT_FOUND");
    if (record.closedAt !== undefined)
      throw subagentAccessError("SUBAGENT_CLOSED");
    input.signal?.throwIfAborted();
    const result = await this.options.stop(input);
    const snapshot = await this.list(input);
    const instance = snapshot.instances.find(
      (item) => item.subagentId === input.subagentId,
    );
    if (!instance) throw subagentAccessError("SUBAGENT_CLOSED");
    return {
      rootSessionId: input.rootSessionId,
      subagentId: input.subagentId,
      expectedExecutionId: input.expectedExecutionId,
      outcome: result?.stopped
        ? result.cleanup === "confirmed"
          ? "confirmed"
          : "accepted"
        : instance.currentExecutionId &&
            instance.currentExecutionId !== input.expectedExecutionId
          ? "execution_changed"
          : "not_running",
      instance,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.revisions.clear();
    this.rootsByChild.clear();
  }
}
