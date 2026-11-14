import { buildRuntimeInputMessage } from "../../core/message/index.js";
import type { CurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";

/** Keep per-run Goal guidance independent from the immutable task batch. */
export async function acceptRuntimeOpening(input: {
  readonly store: CurrentRunInputStore;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly now: number;
  readonly opening: {
    readonly kind: "subagent-status" | "background-task-result";
    readonly sourceId: string;
    readonly body: string;
    readonly goalReminder?: string;
  };
}): Promise<void> {
  const accept = async (
    kind: "subagent-status" | "background-task-result",
    sourceId: string,
    body: string,
    createdAt: number,
  ): Promise<void> => {
    const inputId = `${sourceId}:${input.runId}`;
    await input.store.acceptRuntimeInput({
      inputId,
      runId: input.runId,
      sessionId: input.sessionId,
      source: kind,
      sourceId,
      message: buildRuntimeInputMessage({
        messageId: `runtime:${inputId}`,
        sessionId: input.sessionId,
        agent: input.agentName,
        createdAt,
        origin: { kind, inputId, targetRunId: input.runId, sourceId },
        text: body,
      }),
    });
  };
  if (input.opening.goalReminder)
    await accept(
      "background-task-result",
      `goal-reminder:${input.runId}`,
      input.opening.goalReminder,
      input.now - 1,
    );
  await accept(
    input.opening.kind,
    input.opening.sourceId,
    input.opening.body,
    input.now,
  );
}
