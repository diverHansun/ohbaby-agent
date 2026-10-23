import type { UiPromptSubmission } from "ohbaby-sdk";
import type { PromptProjectionModel } from "../conversation/ConversationStream.js";
import type { ViewModel } from "./selectors.js";

/** A prompt this browser submitted, tracked until the server-side record takes over. */
export interface LocalPromptAttempt {
  readonly clientRequestId: string;
  readonly createdAt: string;
  readonly originSessionId: string | null;
  readonly placement: "conversation" | "queue";
  readonly submittedSessionId?: string;
  readonly text: string;
  readonly userMessageId?: string;
}

export function promptMatchesAttempt(
  prompt: UiPromptSubmission,
  attempt: LocalPromptAttempt,
): boolean {
  return (
    prompt.clientRequestId === attempt.clientRequestId ||
    (attempt.userMessageId !== undefined &&
      prompt.userMessageId === attempt.userMessageId)
  );
}

export function hasLiveRunForSession(
  snapshot: ViewModel["snapshot"],
  sessionId: string | undefined,
): boolean {
  if (!snapshot || !sessionId) return false;
  return snapshot.runs.some(
    (run) =>
      run.sessionId === sessionId &&
      (run.status.kind === "running" ||
        run.status.kind === "waiting-for-permission"),
  );
}

export function hasActiveTurnForSession(
  snapshot: ViewModel["snapshot"],
  sessionId: string | undefined,
): boolean {
  if (!snapshot || !sessionId) return false;
  return (
    hasLiveRunForSession(snapshot, sessionId) ||
    (snapshot.prompts ?? []).some(
      (prompt) =>
        prompt.sessionId === sessionId &&
        (prompt.status === "starting" || prompt.status === "running"),
    )
  );
}

export function localAttemptSessionMatches(
  attempt: LocalPromptAttempt,
  activeSessionId: string | undefined,
): boolean {
  if (activeSessionId === undefined) {
    return attempt.originSessionId === null;
  }
  return (
    attempt.submittedSessionId === activeSessionId ||
    (attempt.submittedSessionId === undefined &&
      attempt.originSessionId === activeSessionId)
  );
}

export function isExpectedPromptInterruption(
  prompt: UiPromptSubmission,
  view: ViewModel,
): boolean {
  if (prompt.status !== "interrupted" || prompt.error?.source !== "runtime")
    return false;
  const run = view.snapshot?.runs.find(
    (candidate) =>
      candidate.id === prompt.runId && candidate.sessionId === prompt.sessionId,
  );
  const terminalReason = prompt.error.terminalReason ?? run?.terminalReason;
  // Successful aborts retain a generic marker alongside the concrete stop reason.
  const reason =
    (terminalReason === undefined || terminalReason === "cancelled") &&
    prompt.error.code === "RUN_INTERRUPTED"
      ? prompt.error.message
      : terminalReason;
  return reason === "user-stop" || reason === "service-shutdown";
}

export function selectPromptProjection(input: {
  readonly attempts: readonly LocalPromptAttempt[];
  readonly view: ViewModel;
}): {
  readonly rows: readonly PromptProjectionModel[];
  readonly startupThinkingAt?: string;
} {
  const activeSessionId = input.view.composer.activeSessionId;
  const activeSession = input.view.activeSession;
  const formalMessageIds = new Set(
    activeSession?.messages.map((message) => message.id) ?? [],
  );
  const prompts = (input.view.snapshot?.prompts ?? []).filter(
    (prompt) => prompt.sessionId === activeSessionId,
  );
  const hasActiveTurn = hasActiveTurnForSession(
    input.view.snapshot,
    activeSessionId,
  );
  const serverRows = prompts.flatMap((prompt): PromptProjectionModel[] => {
    if (formalMessageIds.has(prompt.userMessageId)) return [];
    if (prompt.status === "starting" || prompt.status === "running") {
      return [
        {
          clientRequestId: prompt.clientRequestId,
          createdAt: prompt.createdAt,
          id: prompt.userMessageId,
          text: prompt.text,
        },
      ];
    }
    if (prompt.status === "failed" || prompt.status === "interrupted") {
      return [
        {
          clientRequestId: prompt.clientRequestId,
          createdAt: prompt.createdAt,
          error: isExpectedPromptInterruption(prompt, input.view)
            ? undefined
            : (prompt.error?.message ??
              (prompt.status === "failed"
                ? "Prompt failed before the run started."
                : "Prompt was interrupted before completion.")),
          id: prompt.userMessageId,
          label: prompt.status === "failed" ? "Failed" : "Interrupted",
          text: prompt.text,
        },
      ];
    }
    return [];
  });
  const serverRequestIds = new Set(
    serverRows.map((row) => row.clientRequestId),
  );
  const serverMessageIds = new Set(serverRows.map((row) => row.id));
  const visibleAttempts = input.attempts.filter((attempt) =>
    localAttemptSessionMatches(attempt, activeSessionId),
  );
  const localRows = visibleAttempts.flatMap(
    (attempt): PromptProjectionModel[] => {
      if (attempt.placement !== "conversation") return [];
      const matchingPrompt = prompts.find((prompt) =>
        promptMatchesAttempt(prompt, attempt),
      );
      if (
        serverRequestIds.has(attempt.clientRequestId) ||
        (attempt.userMessageId !== undefined &&
          (formalMessageIds.has(attempt.userMessageId) ||
            serverMessageIds.has(attempt.userMessageId)))
      ) {
        return [];
      }
      if (matchingPrompt) {
        if (matchingPrompt.status !== "queued" || hasActiveTurn) {
          return [];
        }
      }
      return [
        {
          clientRequestId: attempt.clientRequestId,
          createdAt: attempt.createdAt,
          id: attempt.userMessageId ?? `pending:${attempt.clientRequestId}`,
          text: attempt.text,
        },
      ];
    },
  );
  const startupCandidates = [
    ...prompts
      .filter(
        (prompt) => prompt.status === "starting" || prompt.status === "running",
      )
      .map((prompt) => prompt.startedAt ?? prompt.createdAt),
    ...visibleAttempts.flatMap((attempt): string[] => {
      if (attempt.placement !== "conversation") return [];
      const matchingPrompt = prompts.find((prompt) =>
        promptMatchesAttempt(prompt, attempt),
      );
      if (
        matchingPrompt &&
        (matchingPrompt.status === "succeeded" ||
          matchingPrompt.status === "failed" ||
          matchingPrompt.status === "cancelled" ||
          matchingPrompt.status === "interrupted" ||
          (matchingPrompt.status === "queued" && hasActiveTurn))
      ) {
        return [];
      }
      return [attempt.createdAt];
    }),
  ].sort();
  const startupThinkingAt = startupCandidates[0];
  return {
    rows: [...serverRows, ...localRows].sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    ),
    ...(startupCandidates.length === 0 ? {} : { startupThinkingAt }),
  };
}

export function selectPersistedPromptError(view: ViewModel): {
  readonly message: string;
  readonly promptId: string;
} | null {
  const activeSessionId = view.composer.activeSessionId;
  if (
    !activeSessionId ||
    hasActiveTurnForSession(view.snapshot, activeSessionId)
  ) {
    return null;
  }
  const latest = (view.snapshot?.prompts ?? [])
    .filter((prompt) => prompt.sessionId === activeSessionId)
    .reduce<UiPromptSubmission | null>(
      (current, prompt) =>
        current === null || prompt.createdAt >= current.createdAt
          ? prompt
          : current,
      null,
    );
  if (
    !latest ||
    isExpectedPromptInterruption(latest, view) ||
    (latest.status !== "failed" && latest.status !== "interrupted") ||
    !view.activeSession?.messages.some(
      (message) => message.id === latest.userMessageId,
    )
  ) {
    return null;
  }
  return {
    message:
      latest.error?.message ??
      (latest.status === "failed"
        ? "Prompt failed."
        : "Prompt was interrupted."),
    promptId: latest.promptId,
  };
}

/** Whether a local attempt is still needed after this snapshot; once retired the server record is shown instead. */
export function shouldKeepPromptAttempt(
  attempt: LocalPromptAttempt,
  snapshot: ViewModel["snapshot"],
): boolean {
  if (attempt.userMessageId === undefined) return true;
  const matchingPrompt = snapshot?.prompts?.find((prompt) =>
    promptMatchesAttempt(prompt, attempt),
  );
  const sessionId = attempt.submittedSessionId ?? matchingPrompt?.sessionId;
  const formalVisible = snapshot?.sessions
    .find((session) => session.id === sessionId)
    ?.messages.some((message) => message.id === attempt.userMessageId);
  if (matchingPrompt) {
    if (
      matchingPrompt.status === "starting" ||
      matchingPrompt.status === "running" ||
      matchingPrompt.status === "succeeded" ||
      matchingPrompt.status === "failed" ||
      matchingPrompt.status === "cancelled" ||
      matchingPrompt.status === "interrupted"
    ) {
      return false;
    }
    if (
      attempt.placement === "queue" ||
      hasLiveRunForSession(snapshot, sessionId)
    ) {
      return false;
    }
  }
  return !(
    formalVisible === true &&
    (matchingPrompt !== undefined || hasLiveRunForSession(snapshot, sessionId))
  );
}
