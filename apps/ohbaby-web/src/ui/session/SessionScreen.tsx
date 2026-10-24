import { getUnconsumedSteers, type UiBackendClient } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { CommandNoticeList } from "../commands/CommandResultModal.js";
import { StructuredCommandOverlay } from "../commands/StructuredCommandOverlay.js";
import { Composer } from "../composer/Composer.js";
import { TodoDock } from "../conversation/TodoDock.js";
import { ApprovalPanel } from "../permissions/ApprovalPanel.js";
import { PermissionPolicyControl } from "../permissions/PermissionPolicyControl.js";
import { ErrorBanner } from "../shared/ErrorBanner.js";
import { DraftHero } from "./DraftHero.js";
import { selectPersistedPromptError } from "./prompt-projection.js";
import { SessionBanners, SessionSyncNotice } from "./SessionBanners.js";
import { SessionConversation } from "./SessionConversation.js";
import { SubagentView } from "./SubagentView.js";
import { useCommandOverlays } from "./useCommandOverlays.js";
import { useCompactRequest } from "./use-compact-request.js";
import { usePromptSubmission } from "./usePromptSubmission.js";
import { useSessionInteractions } from "./useSessionInteractions.js";
import { useSessionLoad } from "./useSessionLoad.js";
import { useStopRequest } from "./use-stop-request.js";

/**
 * The conversation view of one instance: messages, approvals, the composer,
 * subagent sheet and command overlays. The surrounding shell (sidebar, header,
 * folder picker) lives in `ui/shell`.
 */
export function SessionScreen({
  client,
  runtime,
  initialDraft,
  onInitialDraftConsumed,
}: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
  /** Text typed before a folder was open; it is placed into the composer once. */
  readonly initialDraft?: string;
  readonly onInitialDraftConsumed?: () => void;
}): ReactElement {
  const {
    storeSnapshot,
    view,
    workspace,
    draftScopeKey,
    sessionSyncBanner,
    promptRecoveryReminders,
  } = useSessionLoad(runtime);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissedPromptErrorId, setDismissedPromptErrorId] = useState<
    string | null
  >(null);
  const overlays = useCommandOverlays({
    runtime,
    client,
    draftScopeKey,
    onScopeReset: () => {
      setActionError(null);
    },
  });
  const stopRequest = useStopRequest(
    runtime,
    view.composer.activeSessionId,
    view.composer.activeRunId,
    setActionError,
  );
  const compactRequest = useCompactRequest(
    client,
    view.composer.activeSessionId ?? view.activeSession?.id,
    setActionError,
  );
  const persistedPromptError = useMemo(
    () => selectPersistedPromptError(view),
    [view],
  );
  const errorBannerMessage =
    actionError ??
    view.error ??
    (persistedPromptError?.promptId === dismissedPromptErrorId
      ? null
      : (persistedPromptError?.message ?? null));
  const clearActionError = useCallback(() => {
    setActionError(null);
    setDismissedPromptErrorId(persistedPromptError?.promptId ?? null);
  }, [persistedPromptError]);
  const runAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        clearActionError();
        await action();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [clearActionError],
  );
  const { promptProjection, isPromptAdmitting, submitText } =
    usePromptSubmission({
      runtime,
      client,
      view,
      selectedDirectory: workspace.selectedDirectory,
      draftScopeKey,
      commandScopeGeneration: overlays.commandScopeGeneration,
      openOverlayForSlashText: overlays.openOverlayForSlashText,
      setCommandInputError: overlays.setCommandInputError,
      clearActionError,
      setActionError,
    });
  // Without a configured model, sending opens the model setup instead of failing (D16).
  const modelMissing =
    storeSnapshot.currentModelLoaded && storeSnapshot.currentModel === null;
  const { openOverlayForSlashText, prefillComposer } = overlays;
  const openModelSetup = useCallback((): void => {
    void openOverlayForSlashText("/connect");
  }, [openOverlayForSlashText]);
  const submit = useCallback(
    async (
      ...args: Parameters<typeof submitText>
    ): ReturnType<typeof submitText> => {
      if (modelMissing && !args[0].startsWith("/")) {
        openModelSetup();
        return false;
      }
      return submitText(...args);
    },
    [modelMissing, openModelSetup, submitText],
  );

  // Stable identity: the slash palette refetches its catalog when this changes.
  const listCommands = useCallback(() => runtime.listWebCommands(), [runtime]);

  const contentRef = useRef<HTMLDivElement>(null);
  const interactions = useSessionInteractions({ client, view, contentRef });
  const { viewingSubagent, approvalDialogVisible, childExpanded } =
    interactions;

  // The shell waits for workspace restoration before mounting this handoff.
  // Prefill once, after the composer has restored that final draft scope.
  const initialDraftRef = useRef(initialDraft);
  useEffect(() => {
    const text = initialDraftRef.current;
    if (!text) return;
    initialDraftRef.current = undefined;
    prefillComposer(text);
    onInitialDraftConsumed?.();
  }, [prefillComposer, onInitialDraftConsumed]);

  const showMain =
    !view.isEmpty ||
    view.commandNotices.length > 0 ||
    promptProjection.rows.length > 0 ||
    promptProjection.startupThinkingAt !== undefined ||
    compactRequest.isCompacting(view.activeSession?.id) ||
    (compactRequest.notice !== null &&
      compactRequest.notice.sessionId === view.activeSession?.id);
  const setPermission = (
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): void => {
    void runAction(async () => {
      await client.setPermission(input);
    });
  };

  return (
    <div
      ref={contentRef}
      className={`ohb-main-body ${
        showMain ? "ohb-main-body-chat" : "ohb-main-body-empty"
      }${sessionSyncBanner === "loading" ? " is-loading" : ""}${
        view.activeTodoList ? " has-todos" : ""
      }${approvalDialogVisible ? " has-approval" : ""}`}
    >
      <ApprovalPanel
        visible={!viewingSubagent}
        disabled={storeSnapshot.permissionSync.status !== "ready"}
        error={storeSnapshot.permissionSync.error}
        syncing={storeSnapshot.permissionSync.status === "syncing"}
        onRetry={() => {
          runtime.retryPermissions();
        }}
        onRespond={(request, choice) =>
          runAction(() =>
            client.respondPermission(request.id, { choiceId: choice.id }),
          )
        }
        onCancel={stopRequest.stop}
        canCancel={view.composer.canStop}
        cancelLabel={stopRequest.label}
        permissions={view.pendingPermissions}
      />
      <SessionSyncNotice
        state={sessionSyncBanner}
        error={storeSnapshot.sessionSync.error}
        onRetry={() => {
          runtime.retrySession();
        }}
      />
      <SessionBanners
        runtime={runtime}
        promptRecoveryReminders={promptRecoveryReminders}
        reasoningMissing={
          storeSnapshot.sessionSync.view?.reasoningMissing === true
        }
      />
      <ErrorBanner message={errorBannerMessage} onDismiss={clearActionError} />
      {showMain ? (
        <SessionConversation
          runtime={runtime}
          client={client}
          view={view}
          storeSnapshot={storeSnapshot}
          promptProjection={promptProjection}
          interactions={interactions}
          compacting={compactRequest.isCompacting(view.activeSession?.id)}
          compactNotice={
            compactRequest.notice &&
            compactRequest.notice.sessionId === view.activeSession?.id
              ? compactRequest.notice.text
              : undefined
          }
          onInsertSkill={prefillComposer}
        />
      ) : (
        <DraftHero directory={workspace.selectedDirectory} />
      )}
      <div
        className="ohb-root-composer"
        inert={approvalDialogVisible}
        style={{
          display:
            approvalDialogVisible || (viewingSubagent && childExpanded)
              ? "none"
              : "contents",
        }}
      >
        <Composer
          readOnly={viewingSubagent || approvalDialogVisible}
          client={client}
          compact={!showMain}
          draftScopeKey={draftScopeKey}
          onEditRevision={overlays.trackComposerRevision}
          isPromptAdmitting={isPromptAdmitting}
          prefill={overlays.composerPrefill}
          onListCommands={listCommands}
          onSetPermission={setPermission}
          onStructuredCommand={overlays.openStructuredCommand}
          onSubmit={submit}
          onStop={stopRequest.stop}
          stopLabel={stopRequest.label}
          model={{
            ...view.composer,
            disabled:
              view.composer.disabled ||
              viewingSubagent ||
              approvalDialogVisible,
          }}
          modelLabel={modelMissing ? "Choose model" : view.header.modelLabel}
          onOpenModel={openModelSetup}
          activeGoal={view.activeGoal}
          onExecuteGoalCommand={(input) => runtime.executeSlashCommand(input)}
          onOpenGoalPanel={overlays.openGoalPanel}
          activeSession={view.activeSession}
          queuedPrompts={view.queuedPrompts}
          unconsumedSteers={getUnconsumedSteers(view.activeSession)}
          commandCatalogVersion={view.commandCatalogVersion}
          connectionKind={view.header.connectionKind}
          topContent={
            <>
              <ErrorBanner
                message={
                  overlays.commandInputError?.scopeKey === draftScopeKey
                    ? overlays.commandInputError.message
                    : null
                }
                onDismiss={() => {
                  overlays.setCommandInputError(null);
                }}
              />
              <CommandNoticeList
                notices={view.commandNotices.filter(
                  (notice) => notice.kind === "error",
                )}
                onClose={(id) => {
                  runtime.store.consumeCommand(id);
                }}
              />
              <TodoDock
                key={view.activeTodoList?.sessionId ?? "hidden"}
                todoList={view.activeTodoList}
              />
            </>
          }
          permissionControl={
            <PermissionPolicyControl
              level={view.composer.permissionLevel}
              disabled={view.composer.disabled}
              onSetPermission={setPermission}
            />
          }
        />
      </div>
      {viewingSubagent ? (
        <SubagentView
          reader={interactions.childReader}
          readingCache={interactions.childReadingCache}
          state={interactions.childState}
          rootTitle={view.activeSession?.title ?? "Main conversation"}
          title={
            interactions.childState.conversation?.displayName ?? "Subagent"
          }
          expanded={childExpanded}
          onExpandedChange={interactions.setChildExpanded}
          onClose={interactions.closeChild}
          approvalRequired={view.pendingPermissions.length > 0}
          anchorToken={String(interactions.childAnchorToken)}
        />
      ) : null}
      {!viewingSubagent && overlays.structuredOverlay ? (
        <StructuredCommandOverlay
          key={draftScopeKey}
          client={client}
          compacting={compactRequest.isCompacting(
            view.composer.activeSessionId ?? view.activeSession?.id,
          )}
          onCompact={compactRequest.start}
          onExecuteSlashCommand={(input) => runtime.executeSlashCommand(input)}
          onClose={overlays.closeStructuredOverlay}
          overlay={overlays.structuredOverlay}
          sessionId={view.composer.activeSessionId ?? view.activeSession?.id}
          activeGoal={view.activeGoal}
        />
      ) : null}
    </div>
  );
}
