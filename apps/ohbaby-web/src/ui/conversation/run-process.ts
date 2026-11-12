import {
  listEndedTurns,
  type UiMessage,
  type UiPromptError,
  type UiPromptSubmission,
  type UiRun,
  type UiTurnTiming,
  type UiTurnTrigger,
} from "ohbaby-sdk";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import { messageBodyText } from "./message-text.js";

export type TurnTiming = UiTurnTiming;

/** One turn of the conversation: one main-context run (turn-projection 02 §2.2). */
export interface RunProcess {
  readonly runId: string;
  /** The user prompt that started the run, when there was one. */
  readonly prompt?: UiPromptSubmission;
  readonly trigger: UiTurnTrigger;
  readonly timing: TurnTiming;
  readonly answerId?: string;
  readonly afterId?: string;
  readonly processIds: readonly string[];
  readonly foldable: boolean;
  /** Why the turn failed, shown once at its end; never a stop the user asked for. */
  readonly error?: UiPromptError;
}

/**
 * An interruption the user or the service meant (stop, shutdown) ends the turn
 * normally; it is not a failure to report.
 */
export function isExpectedInterruption(
  status: string | undefined,
  error: UiPromptError,
  runTerminalReason: string | undefined,
): boolean {
  if (status !== "interrupted" || error.source !== "runtime") return false;
  const terminalReason = error.terminalReason ?? runTerminalReason;
  // Successful aborts retain a generic marker alongside the concrete stop reason.
  const reason =
    (terminalReason === undefined || terminalReason === "cancelled") &&
    error.code === "RUN_INTERRUPTED"
      ? error.message
      : terminalReason;
  return reason === "user-stop" || reason === "service-shutdown";
}

/**
 * Lays out each ended turn (`listEndedTurns`) over the visible messages. A
 * turn's final answer is its last assistant message alone: settled, without
 * tool parts and with model text once interruption notes are set aside. A
 * failed or stopped turn can still have one; only a succeeded turn folds.
 *
 * `messages` are the visible messages in conversation order; `allMessages`
 * also holds hidden runtime inputs, which the shared turn rules read.
 */
export function projectRunProcesses(
  messages: readonly UiMessage[],
  prompts: readonly UiPromptSubmission[],
  sessionId: string | null,
  reasoning: Readonly<Partial<Record<string, ReasoningViewState>>>,
  runs: readonly UiRun[] = [],
  allMessages: readonly UiMessage[] = messages,
): RunProcess[] {
  const sessionPrompts = prompts.filter(
    (prompt) => prompt.sessionId === sessionId,
  );
  return listEndedTurns({
    sessionId,
    runs,
    prompts,
    messages: allMessages,
  }).map(({ runId, prompt, trigger, timing, error }) => {
    const owned = messages.filter((message) => message.runId === runId);
    const lastAssistant = owned
      .filter((message) => message.role === "assistant")
      .at(-1);
    // A step that called any tool, hidden ones included, is process rather
    // than an answer (copy improve-2): the model meant to continue after it.
    const answer =
      lastAssistant &&
      lastAssistant.status !== "streaming" &&
      lastAssistant.hiddenToolCalls !== true &&
      !lastAssistant.parts.some(
        (part) => part.type === "tool-call" || part.type === "tool-result",
      ) &&
      messageBodyText(lastAssistant) !== ""
        ? lastAssistant
        : undefined;
    const answerIndex = answer ? owned.indexOf(answer) : -1;
    const processIds = owned
      .slice(0, Math.max(0, answerIndex))
      .filter(
        (message) =>
          message.role !== "user" &&
          (!!reasoning[message.id]?.content.trim() ||
            message.parts.some((part) =>
              part.type === "text" || part.type === "reasoning"
                ? part.text.trim() !== ""
                : true,
            )),
      )
      .map((message) => message.id);
    const hasReasoning =
      answer &&
      (!!reasoning[answer.id]?.content.trim() ||
        answer.parts.some(
          (part) => part.type === "reasoning" && part.text.trim() !== "",
        ));
    const unsettled = owned.some(
      (message) =>
        message.status === "streaming" ||
        message.status === "error" ||
        reasoning[message.id]?.folded === false ||
        message.parts.some(
          (part) =>
            (part.type === "reasoning" && part.endReason === undefined) ||
            (part.type === "tool-call" &&
              ["pending", "running"].includes(part.call.status)),
        ),
    );
    const steered =
      owned.some((message) => message.runtimeInputKind === "user-steer") ||
      sessionPrompts.some(
        (item) => item.steerReceipt?.acceptedTargetRunId === runId,
      );
    const shownError =
      error &&
      !isExpectedInterruption(
        timing.status,
        error,
        runs.find((run) => run.id === runId)?.terminalReason,
      )
        ? error
        : undefined;
    return {
      runId,
      ...(prompt ? { prompt } : {}),
      ...(shownError ? { error: shownError } : {}),
      trigger,
      timing,
      answerId: answer?.id,
      afterId: answer
        ? undefined
        : (lastAssistant?.id ??
          messages.find((message) => message.id === prompt?.userMessageId)
            ?.id ??
          owned.at(-1)?.id),
      processIds,
      foldable:
        timing.status === "succeeded" &&
        answer !== undefined &&
        !unsettled &&
        !steered &&
        (processIds.length > 0 || !!hasReasoning),
    };
  });
}
