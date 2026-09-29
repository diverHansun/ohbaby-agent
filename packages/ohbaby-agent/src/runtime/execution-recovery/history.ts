import type { MessageManager, ToolPart } from "../../core/message/types.js";

export interface InterruptedHistoryInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly contextScopeId?: string;
  readonly reason: string;
  readonly now?: () => number;
}

/** Call only after the original run's model/tool control flow has settled. */
export async function repairInterruptedRunHistory(
  manager: MessageManager,
  input: InterruptedHistoryInput,
): Promise<boolean> {
  let changed = false;
  let before: string | undefined;
  for (;;) {
    const page = await manager.listPageByRun(input.sessionId, input.runId, {
      before,
      limit: 100,
      scope: { contextScopeId: input.contextScopeId },
    });
    for (const message of page.messages) {
      if (message.info.role === "assistant") {
        const unfinished = (message.info.modelRequests ?? []).filter(
          (request) =>
            request.runId === input.runId &&
            request.endedAt === undefined &&
            request.outcome === "running",
        );
        if (unfinished.length) {
          changed = true;
          await manager.updateMessage(message.info.id, {
            modelRequests: unfinished.map((request) => ({
              ...request,
              outcome: "aborted",
              endedAt: (input.now ?? Date.now)(),
              endTimeSource: "recovery",
            })),
          });
        }
      }
      for (const part of message.parts) {
        if (
          part.type !== "tool" ||
          (part.state.status !== "pending" && part.state.status !== "running")
        )
          continue;
        // Avoid unnecessary writes; the store also checks atomically against later results.
        const current = await manager.getPart(part.id);
        if (
          current?.type !== "tool" ||
          (current.state.status !== "pending" &&
            current.state.status !== "running")
        )
          continue;
        changed = (await repairTool(manager, current, input)) || changed;
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    before = page.nextCursor;
  }
  return changed;
}

async function repairTool(
  manager: MessageManager,
  part: ToolPart,
  input: InterruptedHistoryInput,
): Promise<boolean> {
  const recordedAt = (input.now ?? Date.now)();
  const execution = part.metadata?.execution;
  const result = await manager.updatePart(
    part.id,
    {
      state: {
        status: "error",
        input: part.state.input,
        error:
          "Execution interrupted; outcome unknown. The operation may have made changes. It was not replayed.",
      },
      metadata: {
        ...part.metadata,
        recovery: { reason: input.reason, outcome: "unknown", recordedAt },
        ...(execution
          ? {
              execution: {
                ...execution,
                phase: "ended",
                phaseStartedAt: recordedAt,
                endedAt: recordedAt,
                endTimeSource: "recovery",
                cleanup: "unconfirmed",
              },
            }
          : {}),
      },
    },
    { ifToolUnfinished: true },
  );
  const recovery =
    result.type === "tool" ? result.metadata?.recovery : undefined;
  return (
    typeof recovery === "object" &&
    recovery !== null &&
    "recordedAt" in recovery &&
    recovery.recordedAt === recordedAt
  );
}
