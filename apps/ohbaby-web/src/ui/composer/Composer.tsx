import type {
  UiBackendClient,
  UiGoal,
  UiPermissionLevel,
  UiPermissionMode,
  UiPromptSubmission,
  UiReasoningConfig,
  UiSession,
  UiUnconsumedSteer,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  type ExecuteGoalCommand,
  GoalComposerStrip,
  type GoalPanelIntent,
} from "../commands/GoalControl.js";
import { type StructuredCommandRequest } from "../commands/StructuredCommandOverlay.js";
import { ComposerControls } from "./ComposerControls.js";
import { ComposerInput } from "./ComposerInput.js";
import { fitComposerTextarea } from "./composerTextarea.js";
import {
  composerDraftKey,
  readSessionValue,
  removeSessionValue,
  type StoredComposerDraft,
  writeSessionValue,
} from "./draft-storage.js";
import { isImeComposing } from "./ime.js";
import { PromptQueue } from "./PromptQueue.js";
import { UnconsumedSteers } from "./UnconsumedSteers.js";
import { useComposerDraft } from "./useComposerDraft.js";
import { useSlashPalette } from "./useSlashPalette.js";
import { useSteerQueue } from "./useSteerQueue.js";

export type { ComposerPrefill } from "./useComposerDraft.js";

export interface ComposerModel {
  readonly activeRunId?: string;
  readonly activeRunStartedAt?: string;
  readonly activeSessionId?: string;
  readonly canSend: boolean;
  readonly canStop: boolean;
  readonly disabled: boolean;
  readonly isRunning: boolean;
  readonly mode: UiPermissionMode;
  readonly permissionLevel: UiPermissionLevel;
}

const TEXTAREA_FIT = { lineHeight: 24, maxLines: 7 } as const;
const DOUBLE_ESCAPE_MS = 650;

/**
 * The composer: draft, slash palette, queued prompts, goal strip and the card
 * with its control row. State lives in `useComposerDraft`, `useSteerQueue` and
 * `useSlashPalette`; this component wires sending and keyboard handling.
 */
export function Composer(props: {
  readonly client: Pick<
    UiBackendClient,
    | "acquirePromptEditLease"
    | "renewPromptEditLease"
    | "releasePromptEditLease"
    | "editQueuedPrompt"
    | "resubmitRetainedPrompt"
    | "cancelQueuedPrompt"
    | "steerQueuedPrompt"
    | "resendSteerInput"
    | "getCurrentModel"
    | "subscribeEvents"
    | "updateSessionReasoning"
  >;
  readonly compact?: boolean;
  readonly unconsumedSteers?: readonly UiUnconsumedSteer[];
  readonly readOnly?: boolean;
  readonly draftScopeKey: string;
  readonly isPromptAdmitting: boolean;
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (request: StructuredCommandRequest) => void;
  readonly onStop: () => void;
  readonly stopLabel?: string;
  readonly onSubmit: (
    text: string,
    clientRequestId?: string,
    reasoning?: UiReasoningConfig,
  ) => Promise<boolean>;
  readonly prefill?: import("./useComposerDraft.js").ComposerPrefill | null;
  readonly onEditRevision: (revision: number) => void;
  readonly model: ComposerModel;
  /** The model menu in the control row (D15). */
  readonly modelControl?: ReactNode;
  readonly activeGoal?: UiGoal | null;
  readonly onExecuteGoalCommand?: ExecuteGoalCommand;
  readonly onOpenGoalPanel?: (intent?: GoalPanelIntent) => void;
  readonly activeSession: UiSession | null;
  readonly queuedPrompts: readonly UiPromptSubmission[];
  readonly commandCatalogVersion: string | null;
  readonly connectionKind: string;
  readonly topContent: ReactNode;
  readonly permissionControl: ReactNode;
}): ReactElement {
  const selectedReasoning = useRef<UiReasoningConfig | undefined>(undefined);
  useEffect(() => {
    selectedReasoning.current = undefined;
  }, [props.activeSession?.id, props.client]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recoveryRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLDivElement | null>(null);
  const lastEscapeAt = useRef(0);
  const resetSlashRef = useRef<() => void>(() => undefined);

  const state = useComposerDraft({
    client: props.client,
    draftScopeKey: props.draftScopeKey,
    onEditRevision: props.onEditRevision,
    prefill: props.prefill,
    onPrefilled: () => {
      resetSlashRef.current();
      textareaRef.current?.focus();
    },
  });
  const {
    draft,
    draftRef,
    queuedEdit,
    isSubmitting,
    pendingRequestId,
    setPendingRequestId,
    setPendingText,
    setDraft,
    persistDraft,
    updateDraft,
    draftScopeGeneration,
    editRevision,
  } = state;
  const queue = useSteerQueue({
    client: props.client,
    draftScopeKey: props.draftScopeKey,
    queuedPrompts: props.queuedPrompts,
    state,
    textareaRef,
  });

  const canSend =
    props.model.canSend &&
    (!queuedEdit?.leaseLost || queuedEdit.retainedSendText !== undefined) &&
    draft.trim().length > 0 &&
    !isSubmitting &&
    !props.isPromptAdmitting;
  const showStop =
    props.stopLabel !== undefined ||
    (!queuedEdit &&
      ((props.model.isRunning && draft.trim().length === 0) ||
        (props.model.canStop &&
          (!props.model.canSend || draft.trim().length === 0))));
  const canUseSlash =
    props.model.canSend &&
    !queuedEdit &&
    !isSubmitting &&
    !props.isPromptAdmitting;
  const slash = useSlashPalette({
    draftState: state,
    canUseSlash,
    disabled: props.model.disabled,
    commandCatalogVersion: props.commandCatalogVersion,
    onListCommands: props.onListCommands,
    onStructuredCommand: props.onStructuredCommand,
    onSubmit: (text) => props.onSubmit(text),
  });
  resetSlashRef.current = slash.reset;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) fitComposerTextarea(textarea, TEXTAREA_FIT);
  }, [draft, props.model.disabled, slash.slashOpen]);

  useLayoutEffect(() => {
    const recovery = recoveryRef.current;
    const content = recovery?.closest(".ohb-root-composer")?.parentElement;
    if (!recovery || !content) return;
    const measure = (): void => {
      content.style.setProperty(
        "--steer-recovery-space",
        `${String(recovery.getBoundingClientRect().height)}px`,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(recovery);
    return (): void => {
      observer?.disconnect();
      content.style.removeProperty("--steer-recovery-space");
    };
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    const composerInput = composerInputRef.current;
    if (!textarea || !composerInput || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      fitComposerTextarea(textarea, TEXTAREA_FIT);
    });
    observer.observe(composerInput);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (props.readOnly || !text || !canSend) {
      return;
    }
    if (queuedEdit) {
      queue.finishQueuedEdit();
      return;
    }
    const generation = draftScopeGeneration.current;
    const revision = editRevision.current;
    const clientRequestId = pendingRequestId ?? globalThis.crypto.randomUUID();
    setPendingRequestId(clientRequestId);
    setPendingText(text);
    draftRef.current = "";
    setDraft("");
    persistDraft("", clientRequestId, text);
    void props
      .onSubmit(text, clientRequestId, selectedReasoning.current)
      .then((sent) => {
        if (generation !== draftScopeGeneration.current) {
          const key = composerDraftKey(props.draftScopeKey);
          const stored = readSessionValue(key) as StoredComposerDraft | null;
          if (stored?.clientRequestId === clientRequestId) {
            if (sent && !stored.text) removeSessionValue(key);
            else
              writeSessionValue(key, {
                text: stored.text || (sent ? "" : text),
              } satisfies StoredComposerDraft);
          }
          return;
        }
        setPendingRequestId(null);
        setPendingText(null);
        if (sent) {
          if (draftRef.current.length === 0) {
            removeSessionValue(composerDraftKey(props.draftScopeKey));
          } else {
            persistDraft(draftRef.current);
          }
          return;
        }
        const restored =
          editRevision.current === revision && draftRef.current.length === 0
            ? text
            : draftRef.current;
        draftRef.current = restored;
        setDraft(restored);
        persistDraft(restored);
      });
  }, [
    canSend,
    draft,
    draftRef,
    draftScopeGeneration,
    editRevision,
    pendingRequestId,
    persistDraft,
    props.draftScopeKey,
    props.onSubmit,
    props.readOnly,
    queue,
    queuedEdit,
    setDraft,
    setPendingRequestId,
    setPendingText,
  ]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeComposing(event)) return;
      if (slash.handlePaletteKey(event)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
        return;
      }
      if (event.key === "Escape" && queuedEdit) {
        event.preventDefault();
        queue.releaseQueuedEdit();
        return;
      }
      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        props.onSetPermission({
          mode: props.model.mode === "auto" ? "plan" : "auto",
        });
        return;
      }
      if (event.key === "Escape" && props.model.canStop) {
        const now = Date.now();
        if (now - lastEscapeAt.current < DOUBLE_ESCAPE_MS) {
          props.onStop();
          lastEscapeAt.current = 0;
        } else {
          lastEscapeAt.current = now;
        }
      }
    },
    [props, queue, queuedEdit, send, slash],
  );

  const blockReadOnly = (event: {
    preventDefault(): void;
    stopPropagation(): void;
  }): void => {
    if (props.readOnly) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <section
      className={`${props.compact ? "ohb-composer ohb-composer-hero" : "ohb-composer"}${props.readOnly ? " is-readonly" : ""}`}
    >
      <div
        className="ohb-composer-content"
        inert={props.readOnly}
        aria-hidden={props.readOnly ? true : undefined}
        onClickCapture={blockReadOnly}
        onKeyDownCapture={blockReadOnly}
      >
        {props.topContent}
        <div className="ohb-steer-recovery" ref={recoveryRef}>
          <UnconsumedSteers
            inputs={props.unconsumedSteers ?? []}
            disabled={props.model.disabled || props.readOnly === true}
            scopeKey={props.draftScopeKey}
            resend={async (input) => {
              const generation = draftScopeGeneration.current;
              state.setResendError(null);
              let receipt: Awaited<
                ReturnType<typeof props.client.resendSteerInput>
              >;
              try {
                receipt = await props.client.resendSteerInput(input);
              } catch (caught: unknown) {
                // Kept here, not on the row: SSE may remove the row first.
                if (generation === draftScopeGeneration.current)
                  state.setResendError(
                    caught instanceof Error ? caught.message : String(caught),
                  );
                throw caught;
              }
              if (
                generation === draftScopeGeneration.current &&
                receipt.steer?.status === "error"
              ) {
                state.setResendError(
                  `Accepted in queue · ${receipt.steer.error.message}`,
                );
              }
              return receipt;
            }}
          />
          {state.resendError ? (
            <p
              className="ohb-unsent-steer ohb-resend-error ohb-slash-error"
              role="alert"
              tabIndex={0}
            >
              {state.resendError}
            </p>
          ) : null}
        </div>
        <PromptQueue
          prompts={props.queuedPrompts}
          expanded={state.queueExpanded}
          onToggleExpanded={() => {
            state.setQueueExpanded((expanded) => !expanded);
          }}
          editingPromptId={queuedEdit?.promptId}
          busy={isSubmitting || state.queueAcquirePending}
          disabled={props.model.disabled}
          activeRunId={props.model.activeRunId}
          steer={(input) => props.client.steerQueuedPrompt(input)}
          onEdit={queue.beginQueuedEdit}
          onCancel={queue.cancelQueuedPrompt}
        />
        <GoalComposerStrip
          disabled={
            Boolean(props.readOnly) ||
            props.model.disabled ||
            !props.model.canSend ||
            props.isPromptAdmitting ||
            isSubmitting
          }
          goal={props.activeGoal ?? null}
          onExecuteSlashCommand={props.onExecuteGoalCommand}
          onOpenGoalPanel={props.onOpenGoalPanel}
          scopeKey={props.draftScopeKey}
          sessionId={props.model.activeSessionId ?? props.activeSession?.id}
        />
        <ComposerInput
          inputRef={composerInputRef}
          textareaRef={textareaRef}
          planMode={props.model.mode === "plan"}
          compact={props.compact === true}
          draft={draft}
          ariaLabel={`Message, ${props.model.mode} mode, ${props.model.permissionLevel} permission`}
          placeholder={composerPlaceholder(
            props.connectionKind,
            props.model.isRunning,
            props.activeSession !== null,
          )}
          disabled={props.model.disabled || isSubmitting}
          readOnly={queuedEdit?.retainedSendText !== undefined}
          onChange={(nextDraft) => {
            updateDraft(nextDraft);
            slash.onDraftEdited(nextDraft);
          }}
          onKeyDown={onKeyDown}
          slash={{
            open: slash.slashOpen,
            items: slash.slashItems,
            selectedIndex: slash.slashIndex,
            error: slash.slashError,
            onHover: slash.setSlashIndex,
            onRun: slash.runSlashCommand,
          }}
          queueError={state.queueError}
          queuedEdit={queuedEdit}
          controls={
            <ComposerControls
              client={props.client}
              session={props.activeSession}
              permissionControl={props.permissionControl}
              permission={{
                level: props.model.permissionLevel,
                disabled: props.model.disabled,
                onSet: props.onSetPermission,
              }}
              modelControl={props.modelControl}
              onReasoningChange={(reasoning) => {
                selectedReasoning.current = reasoning;
              }}
              showStop={showStop}
              stopLabel={props.stopLabel}
              canStop={props.model.canStop}
              onStop={props.onStop}
              canSend={canSend}
              sendLabel={sendLabel(queuedEdit)}
              admitting={props.isPromptAdmitting}
              onSend={send}
            />
          }
        />
      </div>
      {props.readOnly ? (
        <div className="ohb-composer-readonly-label">Read-only subagent</div>
      ) : null}
    </section>
  );
}

function sendLabel(
  queuedEdit: import("./draft-storage.js").QueuedEditState | null,
): string {
  if (!queuedEdit) return "Send message";
  if (queuedEdit.retainedSendText !== undefined) return "Retry retained send";
  return queuedEdit.status === "retained"
    ? "Send retained prompt"
    : "Save queued prompt";
}

function composerPlaceholder(
  connectionKind: string,
  isRunning: boolean,
  inSession: boolean,
): string {
  if (
    ["connecting", "reconnecting", "resyncing", "disconnected"].includes(
      connectionKind,
    )
  ) {
    return "Draft while reconnecting…";
  }
  if (isRunning) return "Steer now or queue a follow-up...";
  return inSession
    ? "Follow up, or type / for commands"
    : "Describe a task, or type / for commands";
}
