import type { UiMessage, UiPromptSubmission } from "ohbaby-sdk";
import type { ReasoningViewState } from "../../api/daemon/wire.js";

export interface RunProcess {
  readonly prompt: UiPromptSubmission;
  readonly answerId?: string;
  readonly afterId?: string;
  readonly processIds: readonly string[];
  readonly foldable: boolean;
}

/** Messages are already filtered and ordered by the owning conversation. */
export function projectRunProcesses(
  messages: readonly UiMessage[],
  prompts: readonly UiPromptSubmission[],
  sessionId: string | null,
  reasoning: Readonly<Partial<Record<string, ReasoningViewState>>>,
): RunProcess[] {
  const sessionPrompts = prompts.filter(
    (prompt) => prompt.sessionId === sessionId,
  );
  return sessionPrompts
    .filter(
      (prompt) =>
        prompt.endedAt !== undefined &&
        Number.isFinite(Date.parse(prompt.createdAt)) &&
        Number.isFinite(Date.parse(prompt.endedAt)) &&
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          prompt.status,
        ),
    )
    .map((prompt) => {
      const owned =
        prompt.runId === undefined
          ? []
          : messages.filter((message) => message.runId === prompt.runId);
      const lastAssistant = owned
        .filter((message) => message.role === "assistant")
        .at(-1);
      const answer =
        lastAssistant &&
        lastAssistant.status !== "streaming" &&
        lastAssistant.status !== "error" &&
        lastAssistant.parts.some(
          (part) => part.type === "text" && part.text.trim() !== "",
        ) &&
        !lastAssistant.parts.some(
          (part) => part.type === "tool-call" || part.type === "tool-result",
        )
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
        (prompt.runId !== undefined &&
          sessionPrompts.some(
            (item) => item.steerReceipt?.acceptedTargetRunId === prompt.runId,
          ));
      return {
        prompt,
        answerId: answer?.id,
        afterId: answer
          ? undefined
          : (lastAssistant?.id ??
            messages.find((message) => message.id === prompt.userMessageId)
              ?.id),
        processIds,
        foldable:
          prompt.status === "succeeded" &&
          answer !== undefined &&
          !unsettled &&
          !steered &&
          (processIds.length > 0 || !!hasReasoning),
      };
    });
}
