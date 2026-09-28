import type {
  UiSubagentBudget,
  UiSubagentExecution,
  UiSubagentExecutionList,
  UiSubagentExecutionView,
  UiSubagentQuery,
} from "ohbaby-sdk";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { SourceSessionProjection } from "../ui-state/source-session-projection.js";

export const projectSubagentExecution = (
  record: SubagentExecutionRecord,
): UiSubagentExecution => ({
  executionId: record.executionId,
  subagentId: record.subagentId,
  rootSessionId: record.rootSessionId,
  rootRunId: record.rootRunId,
  childSessionId: record.childSessionId,
  childScopeId: record.childScopeId,
  childRunId: record.childRunId,
  status: record.status,
  createdAt: record.createdAt,
  startedAt: record.startedAt,
  completedAt: record.completedAt,
  updatedAt: record.updatedAt,
  terminalReason: record.reason,
  resultStored: record.completedAt !== undefined,
  delivery: record.delivery.state,
  processedRequestId: record.delivery.processedRequestId,
  artifactPath:
    record.artifact.state === "ready" ? record.artifact.path : undefined,
  childUserMessageId: record.childUserMessageId,
  delegationSequence: record.delegationSequence,
  requestId: record.requestId,
  requesterRunId: record.requesterRunId,
  requesterScopeId: record.requesterScopeId,
  parentSessionId: record.parentSessionId,
});

export function createSubagentViewReader(options: {
  readonly executions: SubagentExecutionStore;
  readonly source: SourceSessionProjection;
  readonly rootExists: (id: string) => Promise<boolean>;
  readonly activeRootRun?: (id: string) => Promise<string | undefined>;
  readonly waitState?: (runId: string) => {
    waiting: boolean;
    approvalBlocked: boolean;
  };
  readonly budget?: (executionId: string) => UiSubagentBudget | undefined;
}): {
  list(input: UiSubagentQuery): Promise<UiSubagentExecutionList>;
  view(
    input: UiSubagentQuery & { executionId: string },
  ): Promise<UiSubagentExecutionView>;
} {
  const validate = async (input: UiSubagentQuery): Promise<number> => {
    input.signal?.throwIfAborted();
    if (!(await options.rootExists(input.rootSessionId)))
      throw new Error("Unknown primary session");
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Object.assign(new Error("Page limit must be between 1 and 100"), {
        code: "INVALID_SESSION_QUERY",
      });
    return limit;
  };
  const project = (record: SubagentExecutionRecord): UiSubagentExecution => ({
    ...projectSubagentExecution(record),
    budget: options.budget?.(record.executionId),
  });
  return {
    async list(input) {
      const limit = await validate(input);
      const before = input.before
        ? decodeCursor(input.before, input.rootSessionId)
        : undefined;
      const records = await options.executions.list({
        rootSessionId: input.rootSessionId,
        before,
        limit: limit + 1,
      });
      if (
        records.some((record) => record.rootSessionId !== input.rootSessionId)
      )
        throw new Error("Execution root mismatch");
      const runId = await options.activeRootRun?.(input.rootSessionId);
      const current = runId
        ? await options.executions.listByRootRun(runId)
        : [];
      const wait = runId ? options.waitState?.(runId) : undefined;
      input.signal?.throwIfAborted();
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return {
        executions: page.map(project),
        hasMore: records.length > limit,
        before:
          records.length > limit && last
            ? encodeCursor(input.rootSessionId, last)
            : undefined,
        waiting: wait?.waiting ?? false,
        approvalBlocked: wait?.approvalBlocked ?? false,
        activeCount: current.filter(
          (r) => r.status === "queued" || r.status === "running",
        ).length,
        completedCount: current.filter(
          (r) => r.status !== "queued" && r.status !== "running",
        ).length,
      };
    },
    async view(input) {
      const limit = await validate(input);
      const record = await options.executions.getForRoot(
        input.executionId,
        input.rootSessionId,
      );
      if (record?.rootSessionId !== input.rootSessionId)
        throw new Error("Unknown execution for this root");
      const history =
        record.childSessionId && record.childScopeId && record.childRunId
          ? await options.source.executionHistory(
              record.childSessionId,
              record.childScopeId,
              record.childRunId,
              input.before,
              limit,
            )
          : undefined;
      if (!history && input.before)
        throw new Error("Execution has no process history");
      input.signal?.throwIfAborted();
      return {
        execution: project(record),
        version: history?.version,
        messages: history?.messages ?? [],
        history: {
          before: history?.before,
          hasMore: history?.hasMore ?? false,
        },
        reasoningMissing: history?.reasoningMissing ?? false,
        output: record.output,
        error: record.error,
        readOnly: true,
      };
    },
  };
}
function encodeCursor(
  rootSessionId: string,
  record: SubagentExecutionRecord,
): string {
  return Buffer.from(
    JSON.stringify({
      rootSessionId,
      createdAt: record.createdAt,
      executionId: record.executionId,
    }),
  ).toString("base64url");
}
function decodeCursor(
  cursor: string,
  rootSessionId: string,
): { createdAt: number; executionId: string } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid execution cursor"), {
      code: "INVALID_SESSION_QUERY",
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("rootSessionId" in value) ||
    value.rootSessionId !== rootSessionId ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !("executionId" in value) ||
    typeof value.executionId !== "string"
  )
    throw Object.assign(new Error("Invalid execution cursor"), {
      code: "INVALID_SESSION_QUERY",
    });
  return { createdAt: value.createdAt, executionId: value.executionId };
}
