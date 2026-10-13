import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type { RunSummaryWindow } from "../../core/message/types.js";

/** Same-scope turns are serialized by the host. Never infer history for a runless legacy execution. */
export async function subagentSummaryWindow(
  record: SubagentExecutionRecord,
  executions: Pick<SubagentExecutionStore, "list">,
): Promise<RunSummaryWindow | undefined> {
  if (!record.childRunId || record.startedAt === undefined) return undefined;
  const query = {
    rootSessionId: record.rootSessionId,
    subagentId: record.subagentId,
    ascending: true,
    startedOnly: true,
    limit: 1,
  } as const;
  let next = (
    await executions.list({
      ...query,
      ...(record.delegationSequence === undefined
        ? {
            legacyOnly: true,
            after: {
              createdAt: record.createdAt,
              executionId: record.executionId,
            },
          }
        : { afterSequence: record.delegationSequence }),
    })
  ).at(0);
  if (!next && record.delegationSequence === undefined)
    next = (await executions.list({ ...query, afterSequence: 0 })).at(0);
  return {
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    nextStartedAt:
      next !== undefined &&
      next.childSessionId === record.childSessionId &&
      next.childScopeId === record.childScopeId
        ? next.startedAt
        : undefined,
  };
}
