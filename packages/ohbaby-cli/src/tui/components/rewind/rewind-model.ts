import type { UiGoal, UiPromptSubmission } from "ohbaby-sdk";

/** Prompts that started a turn the user can rewind to, newest first. */
export function rewindablePrompts(
  prompts: readonly UiPromptSubmission[],
  sessionId: string | null,
): readonly UiPromptSubmission[] {
  return prompts
    .filter(
      (prompt) =>
        prompt.sessionId === sessionId &&
        prompt.rewoundAt === undefined &&
        // Queued and starting prompts have no message yet; steers join a turn.
        ["running", "succeeded", "failed", "cancelled", "interrupted"].includes(
          prompt.status,
        ),
    )
    .sort(
      (left, right) =>
        (right.startedAt ?? right.createdAt).localeCompare(
          left.startedAt ?? left.createdAt,
        ) || right.promptId.localeCompare(left.promptId),
    );
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * The confirmation line (frontend design §5.2). `turns` counts the selected
 * turn too, unlike the Web hint's "later turns".
 */
export function rewindConfirmation(input: {
  readonly turns: number;
  readonly goal: UiGoal | null | undefined;
  readonly running: boolean;
  readonly queued: number;
  /** The input already holds text that the restored prompt will replace. */
  readonly hasDraft?: boolean;
}): string {
  return [
    `Rewind ${count(input.turns, "turn", "turns")}.`,
    "File changes won't be undone.",
    ...(input.goal ? ["Goal turns already used won't be refunded."] : []),
    ...(input.running ? ["The current task will stop first."] : []),
    ...(input.queued > 0
      ? [
          `${count(input.queued, "queued message", "queued messages")} will be removed.`,
        ]
      : []),
    ...(input.goal?.status === "active" ? ["The goal will pause."] : []),
    ...(input.hasDraft ? ["Your draft will be replaced."] : []),
    "Enter to confirm, Esc to cancel.",
  ].join(" ");
}

/** The first line of a prompt, for one list row. */
export function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
