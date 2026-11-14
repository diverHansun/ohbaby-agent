import type { UiPromptError, UiPromptSubmission } from "../contract/prompt.js";
import type { UiMessage, UiRun } from "../contract/snapshot.js";

/**
 * Turns as clients show them: one per ended main run, whether a user prompt,
 * a goal turn or a subagent result started it. Web and TUI share these rules
 * so a turn's time, result and label read the same in both.
 */

/** What started a turn; mirrors `UiRun.trigger`. */
export type UiTurnTrigger = "user" | "goal" | "subagent" | "background-task";

/** The facts a turn's end line needs, from its prompt or else its run. */
export interface UiTurnTiming {
  /** Stable per turn: keys a live clock. */
  readonly id: string;
  /** Absent when recovery lost the real start. */
  readonly startedAt?: string;
  readonly endedAt: string;
  /** Terminal result; absent when an older server sent none. */
  readonly status?: string;
  readonly recovered: boolean;
}

export interface UiTurn {
  /** One safe terminal error for this visible turn; prompt takes precedence. */
  readonly error?: UiPromptError;
  readonly runId: string;
  /** The user prompt that started the run, when there was one. */
  readonly prompt?: UiPromptSubmission;
  readonly trigger: UiTurnTrigger;
  readonly timing: UiTurnTiming;
}

const ENDED = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const PENDING = new Set(["queued", "retained", "starting", "running"]);

/** Whether a prompt can still change: queued, held back or running. */
export function isPromptPending(prompt: UiPromptSubmission): boolean {
  return PENDING.has(prompt.status);
}

/**
 * The session's ended turns in the order their runs started. A run whose
 * prompt is still pending has not ended as a turn yet: the run reports its end
 * before the prompt does, and the turn's timing comes from the prompt. A run
 * without a prompt counts only once it wrote a message of its own (hidden
 * runtime inputs do not count), or ended with an automatic-run error. A user
 * turn keeps its prompt, which anchors it even when the run
 * wrote nothing else. `messages` must include hidden runtime inputs, which
 * identify subagent wake-ups recorded before runs carried a trigger.
 */
export function listEndedTurns(input: {
  readonly sessionId: string | null;
  readonly runs: readonly UiRun[];
  readonly prompts: readonly UiPromptSubmission[];
  readonly messages: readonly UiMessage[];
}): UiTurn[] {
  const promptByRun = new Map<string, UiPromptSubmission>();
  const pendingRuns = new Set<string>();
  for (const prompt of input.prompts) {
    if (prompt.sessionId !== input.sessionId || prompt.runId === undefined)
      continue;
    if (isPromptPending(prompt)) pendingRuns.add(prompt.runId);
    else if (
      ENDED.has(prompt.status) &&
      Number.isFinite(Date.parse(prompt.createdAt))
    )
      promptByRun.set(prompt.runId, prompt);
  }
  const runById = new Map(
    input.runs
      .filter((run) => run.sessionId === input.sessionId)
      .map((run) => [run.id, run] as const),
  );
  const withMessages = new Set(
    input.messages.flatMap((message) =>
      message.runId === undefined || message.runtimeInputKind !== undefined
        ? []
        : [message.runId],
    ),
  );
  return [...new Set([...runById.keys(), ...promptByRun.keys()])]
    .flatMap((runId) => {
      if (pendingRuns.has(runId)) return [];
      const run = runById.get(runId);
      const prompt = promptByRun.get(runId);
      const automaticFailure =
        (run?.trigger === "subagent" ||
          run?.trigger === "goal" ||
          run?.trigger === "background-task") &&
        (run.outcome === "failed" || run.outcome === "interrupted") &&
        run.error !== undefined;
      if (!prompt && !withMessages.has(runId) && !automaticFailure) return [];
      const timing = turnTiming(run, prompt);
      if (!timing) return [];
      const opening = input.messages.find((message) => message.runId === runId);
      const turn: UiTurn = {
        runId,
        ...(prompt ? { prompt } : {}),
        ...((timing.status === "failed" || timing.status === "interrupted") &&
        (prompt?.error ?? run?.error)
          ? { error: prompt?.error ?? run?.error }
          : {}),
        trigger: turnTrigger(run, prompt, opening),
        timing,
      };
      // A queued prompt is accepted long before its run starts.
      return [
        { turn, order: run?.startedAt ?? timing.startedAt ?? timing.endedAt },
      ];
    })
    .sort(
      (left, right) =>
        left.order.localeCompare(right.order) ||
        (left.turn.runId < right.turn.runId
          ? -1
          : left.turn.runId > right.turn.runId
            ? 1
            : 0),
    )
    .map(({ turn }) => turn);
}

/**
 * A user turn keeps its prompt's timing, as before runs carried one; any other
 * turn uses its run. The run's outcome wins, with the prompt's status as the
 * fallback for older servers.
 */
function turnTiming(
  run: UiRun | undefined,
  prompt: UiPromptSubmission | undefined,
): UiTurnTiming | undefined {
  const endedAt = prompt?.endedAt ?? run?.endedAt;
  if (endedAt === undefined || !Number.isFinite(Date.parse(endedAt)))
    return undefined;
  const status = run?.outcome ?? prompt?.status;
  const recovered =
    (prompt?.endTimeSource ?? run?.endTimeSource) === "recovery";
  const startedAt = prompt
    ? (prompt.acceptedAt ?? prompt.createdAt)
    : run?.startedAt;
  return {
    id: prompt?.promptId ?? run?.id ?? endedAt,
    ...(recovered || startedAt === undefined ? {} : { startedAt }),
    endedAt,
    ...(status === undefined ? {} : { status }),
    recovered,
  };
}

/**
 * The run's own trigger, or for runs recorded before triggers existed: a run
 * with no prompt that opened on a subagent status input was a wake-up. A run
 * that only received a result midway keeps no label.
 */
function turnTrigger(
  run: UiRun | undefined,
  prompt: UiPromptSubmission | undefined,
  opening: UiMessage | undefined,
): UiTurnTrigger {
  if (run?.trigger && run.trigger !== "user") return run.trigger;
  if (prompt) return "user";
  return opening?.runtimeInputKind === "subagent-status" ? "subagent" : "user";
}

/** The label a turn's end line carries for what started it, if any. */
export function turnTriggerLabel(trigger: UiTurnTrigger): string | undefined {
  if (trigger === "subagent") return "Subagent update";
  if (trigger === "background-task") return "Background task update";
  return undefined;
}
