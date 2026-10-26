import { getUnconsumedSteers, type UiBackendClient } from "ohbaby-sdk";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { CommandNoticeList } from "../commands/CommandResultModal.js";
import { StructuredCommandOverlay } from "../commands/StructuredCommandOverlay.js";
import { Composer } from "../composer/Composer.js";
import {
  resolveModelEntry,
  useSettingsModels,
} from "../composer/model-choice.js";
import { ModelMenu } from "../composer/ModelMenu.js";
import { TodoDock } from "../conversation/TodoDock.js";
import { ApprovalPanel } from "../permissions/ApprovalPanel.js";
import { PermissionPolicyControl } from "../permissions/PermissionPolicyControl.js";
import { Banner } from "../shared/Banner.js";
import { readableError } from "../shared/error-text.js";
import { DraftHero } from "./DraftHero.js";
import { selectPersistedPromptError } from "./prompt-projection.js";
import { isConnectionAbnormal } from "./selectors.js";
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
  draftPicker,
  onOpenModelSettings,
  onError,
}: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
  /** Workspace picker for a new-chat draft; hidden once a session is bound. */
  readonly draftPicker?: ReactNode;
  /** Opens Settings › Models; `fromDraft` when a draft send found no model. */
  readonly onOpenModelSettings: (fromDraft: boolean) => void;
  /** Failures away from where the user is looking: the top-right notices. */
  readonly onError: (error: unknown) => void;
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
  const promptErrorMessage =
    persistedPromptError?.promptId === dismissedPromptErrorId
      ? null
      : (persistedPromptError?.message ?? null);
  // While the transport is down the header shows it; its errors stay quiet.
  const stateError = isConnectionAbnormal(view.header.connectionKind)
    ? null
    : view.error;
  // State errors clear themselves, so only action and prompt errors dismiss.
  const errorBanner =
    actionError !== null
      ? { message: actionError, dismissable: true }
      : stateError
        ? { message: stateError, dismissable: false }
        : promptErrorMessage
          ? { message: promptErrorMessage, dismissable: true }
          : null;
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
      view,
      selectedDirectory: workspace.selectedDirectory,
      draftScopeKey,
      commandScopeGeneration: overlays.commandScopeGeneration,
      openOverlayForSlashText: overlays.openOverlayForSlashText,
      setCommandInputError: overlays.setCommandInputError,
      clearActionError,
      setActionError,
    });
  // Without a configured model, sending opens Settings › Models instead of
  // failing (D16). A failed read of the model is not "missing".
  const modelMissing =
    storeSnapshot.currentModelLoaded && storeSnapshot.currentModel === null;
  const { prefillComposer } = overlays;
  const inDraft = view.composer.activeSessionId === undefined;
  // A chat keeps its model on the session (session-model 00 D17); a draft
  // holds the choice here until its first prompt saves it on the new session.
  const models = useSettingsModels(runtime.settings);
  const [draftModel, setDraftModel] = useState<string>();
  // Every draft shares one scope, so the choice ends with the draft it was
  // made in: the next draft starts on the default again.
  useEffect(() => {
    if (!inDraft) setDraftModel(undefined);
  }, [inDraft]);
  const selectedEntryId = inDraft
    ? draftModel
    : view.activeSession?.modelEntryId;
  const modelEntry = resolveModelEntry(models, selectedEntryId);
  const activeSessionId = view.composer.activeSessionId;
  const selectModel = useCallback(
    async (id: string): Promise<void> => {
      if (activeSessionId === undefined) {
        setDraftModel(id);
        return;
      }
      await client.updateSessionModel({
        sessionId: activeSessionId,
        modelEntryId: id,
      });
    },
    [activeSessionId, client],
  );
  // A choice deleted since it was made falls back to the default, so the
  // draft sends nothing and the server picks the default as well.
  const draftEntryId =
    inDraft && modelEntry?.id === selectedEntryId ? selectedEntryId : undefined;
  const submit = useCallback(
    async (
      text: string,
      clientRequestId?: string,
      reasoning?: Parameters<typeof submitText>[2],
    ): ReturnType<typeof submitText> => {
      if (modelMissing && !text.startsWith("/")) {
        onOpenModelSettings(inDraft);
        return false;
      }
      return submitText(text, clientRequestId, reasoning, draftEntryId);
    },
    [modelMissing, onOpenModelSettings, inDraft, submitText, draftEntryId],
  );

  // Stable identity: the slash palette refetches its catalog when this changes.
  const listCommands = useCallback(() => runtime.listWebCommands(), [runtime]);

  const contentRef = useRef<HTMLDivElement>(null);
  const interactions = useSessionInteractions({ client, view, contentRef });
  const { viewingSubagent, approvalDialogVisible, childExpanded } =
    interactions;

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
      <div className="ohb-banner-stack">
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
        <Banner
          tone="error"
          message={errorBanner ? readableError(errorBanner.message) : null}
          onDismiss={errorBanner?.dismissable ? clearActionError : undefined}
        />
      </div>
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
        <DraftHero
          picker={
            view.composer.activeSessionId === undefined
              ? draftPicker
              : undefined
          }
        />
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
          modelControl={
            <ModelMenu
              key={activeSessionId ?? "draft"}
              settings={runtime.settings}
              models={models}
              selectedEntryId={selectedEntryId}
              onSelect={selectModel}
              fallbackLabel={view.header.modelLabel}
              missing={modelMissing}
              disabled={viewingSubagent || approvalDialogVisible}
              onManage={() => {
                onOpenModelSettings(false);
              }}
              onError={onError}
            />
          }
          modelEntry={modelEntry}
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
              <Banner
                tone="error"
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
