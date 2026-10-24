import type { UiBackendClient, UiReasoningConfig } from "ohbaby-sdk";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import type { PromptProjectionModel } from "../conversation/ConversationStream.js";
import {
  hasActiveTurnForSession,
  localAttemptSessionMatches,
  type LocalPromptAttempt,
  selectPromptProjection,
  shouldKeepPromptAttempt,
} from "./prompt-projection.js";
import type { ViewModel } from "./selectors.js";
import type { CommandInputError } from "./useCommandOverlays.js";

/**
 * Submits prompts and slash commands for the active conversation, and keeps the
 * local attempts shown until the server-side prompt record replaces them.
 */
export function usePromptSubmission(input: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
  readonly view: ViewModel;
  readonly selectedDirectory: string | null;
  readonly draftScopeKey: string;
  readonly commandScopeGeneration: RefObject<number>;
  readonly openOverlayForSlashText: (
    text: string,
  ) => Promise<boolean | "goal-resume-with-arguments">;
  readonly setCommandInputError: (error: CommandInputError | null) => void;
  readonly clearActionError: () => void;
  readonly setActionError: (message: string | null) => void;
}): {
  readonly promptProjection: {
    readonly rows: readonly PromptProjectionModel[];
    readonly startupThinkingAt?: string;
  };
  readonly isPromptAdmitting: boolean;
  readonly submitText: (
    text: string,
    clientRequestId?: string,
    reasoning?: UiReasoningConfig,
  ) => Promise<boolean>;
} {
  const {
    runtime,
    client,
    view,
    selectedDirectory,
    draftScopeKey,
    commandScopeGeneration,
    openOverlayForSlashText,
    setCommandInputError,
    clearActionError,
    setActionError,
  } = input;
  const [localPromptAttempts, setLocalPromptAttempts] = useState<
    readonly LocalPromptAttempt[]
  >([]);
  const promptProjection = useMemo(
    () => selectPromptProjection({ attempts: localPromptAttempts, view }),
    [localPromptAttempts, view],
  );
  const isPromptAdmitting = localPromptAttempts.some(
    (attempt) =>
      attempt.userMessageId === undefined &&
      localAttemptSessionMatches(attempt, view.composer.activeSessionId),
  );

  useEffect(() => {
    const keepAttempt = (attempt: LocalPromptAttempt): boolean =>
      shouldKeepPromptAttempt(attempt, view.snapshot);
    // Even a same-state setter can schedule work while SyncLane stream updates
    // are pending. Only enqueue cleanup when this snapshot retires an attempt.
    if (!localPromptAttempts.some((attempt) => !keepAttempt(attempt))) return;
    setLocalPromptAttempts((attempts) => {
      const next = attempts.filter(keepAttempt);
      return next.length === attempts.length ? attempts : next;
    });
  }, [localPromptAttempts, view.snapshot]);

  const submitSlashCommand = useCallback(
    async (text: string, clientRequestId?: string): Promise<boolean> => {
      const generation = commandScopeGeneration.current;
      const opened = await openOverlayForSlashText(text);
      if (generation !== commandScopeGeneration.current) return false;
      if (opened === true) return true;
      const resumeWithArguments = opened === "goal-resume-with-arguments";
      clearActionError();
      try {
        const completion = await runtime.executeSlashCommand({
          ...(resumeWithArguments ? { allowOverlay: true } : {}),
          ...(view.composer.activeSessionId === undefined
            ? {}
            : { sessionId: view.composer.activeSessionId }),
          text,
          clientRequestId,
        });
        if (
          resumeWithArguments &&
          completion.status === "failed" &&
          generation === commandScopeGeneration.current
        ) {
          setCommandInputError({
            scopeKey: draftScopeKey,
            clientRequestId,
            message: completion.error.message,
          });
        }
        return completion.status === "completed";
      } catch (error) {
        if (
          generation === commandScopeGeneration.current &&
          (resumeWithArguments ||
            !(
              typeof error === "object" &&
              error !== null &&
              "commandFeedback" in error
            ))
        )
          setCommandInputError({
            scopeKey: draftScopeKey,
            clientRequestId,
            message: error instanceof Error ? error.message : String(error),
          });
        return false;
      }
    },
    [
      clearActionError,
      commandScopeGeneration,
      draftScopeKey,
      openOverlayForSlashText,
      runtime,
      setCommandInputError,
      view.composer.activeSessionId,
    ],
  );

  const submitText = useCallback(
    async (
      text: string,
      clientRequestId?: string,
      reasoning?: UiReasoningConfig,
    ): Promise<boolean> => {
      if (text.startsWith("/")) {
        return submitSlashCommand(text, clientRequestId);
      }
      const requestId = clientRequestId ?? globalThis.crypto.randomUUID();
      const submittedSessionId = view.composer.activeSessionId;
      const placement =
        submittedSessionId !== undefined &&
        (hasActiveTurnForSession(view.snapshot, submittedSessionId) ||
          localPromptAttempts.some(
            (attempt) =>
              attempt.placement === "conversation" &&
              localAttemptSessionMatches(attempt, submittedSessionId),
          ))
          ? "queue"
          : "conversation";
      try {
        clearActionError();
        setLocalPromptAttempts((attempts) => [
          ...attempts.filter(
            (attempt) => attempt.clientRequestId !== requestId,
          ),
          {
            clientRequestId: requestId,
            createdAt: new Date().toISOString(),
            originSessionId: submittedSessionId ?? null,
            placement,
            ...(submittedSessionId === undefined ? {} : { submittedSessionId }),
            text,
          },
        ]);
        const receipt = await client.submitPromptAccepted(text, {
          ...(reasoning === undefined ? {} : { reasoning }),
          clientRequestId: requestId,
          ...(submittedSessionId === undefined
            ? {}
            : { sessionId: submittedSessionId }),
        });
        if (receipt.steer?.status === "error") {
          setActionError(`Accepted in queue · ${receipt.steer.error.message}`);
        }
        if (receipt.clientRequestId !== requestId) {
          throw new Error("Prompt receipt did not match this submission");
        }
        setLocalPromptAttempts((attempts) =>
          attempts.map((attempt) =>
            attempt.clientRequestId === requestId
              ? {
                  ...attempt,
                  submittedSessionId: receipt.sessionId,
                  userMessageId: receipt.userMessageId,
                }
              : attempt,
          ),
        );
        if (
          submittedSessionId === undefined &&
          runtime.store.getSnapshot().sessionSync.scope === null &&
          runtime.getWorkspaceSnapshot().selectedDirectory === selectedDirectory
        ) {
          void runtime
            .selectSession(receipt.sessionId)
            .catch((error: unknown) => {
              setActionError(
                `Prompt accepted, but the session could not be opened: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
        }
        return true;
      } catch (error) {
        setLocalPromptAttempts((attempts) =>
          attempts.filter((attempt) => attempt.clientRequestId !== requestId),
        );
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [
      clearActionError,
      client,
      localPromptAttempts,
      runtime,
      selectedDirectory,
      setActionError,
      submitSlashCommand,
      view.composer.activeSessionId,
      view.snapshot,
    ],
  );

  return { promptProjection, isPromptAdmitting, submitText };
}
