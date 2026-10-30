import {
  getUnconsumedSteers,
  type UiBackendClient,
  type UiSubagentInstanceReaderState,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useMemo } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import {
  CommandNoticeList,
  CommandResultModal,
} from "../commands/CommandResultModal.js";
import { createCommandResultModel } from "../commands/slashCommands.js";
import { ConversationPresentation } from "../conversation/ConversationPresentation.js";
import {
  ConversationStream,
  type PromptProjectionModel,
} from "../conversation/ConversationStream.js";
import { DurationSampleContext } from "../conversation/use-execution-duration.js";
import {
  findInstance,
  isClosedInstance,
} from "../shared/subagent-instances.js";
import {
  DelegationRow,
  delegationExecution,
  delegationNotStarted,
  isDelegationCall,
} from "./DelegationRow.js";
import type { ViewModel } from "./selectors.js";
import type { useSessionInteractions } from "./useSessionInteractions.js";

/** The message stream of the active conversation, with command results. */
export function SessionConversation(props: {
  readonly runtime: OhbabyWebRuntime;
  readonly client: UiBackendClient;
  readonly view: ViewModel;
  readonly storeSnapshot: ReturnType<OhbabyWebRuntime["store"]["getSnapshot"]>;
  readonly promptProjection: {
    readonly rows: readonly PromptProjectionModel[];
    readonly startupThinkingAt?: string;
  };
  readonly interactions: ReturnType<typeof useSessionInteractions>;
  readonly compacting: boolean;
  readonly compactNotice?: string;
  readonly onInsertSkill: (text: string) => void;
  /** The session's instance snapshot, shared with the right panel. */
  readonly subagentInstances?: UiSubagentInstanceReaderState;
  readonly onOpenSubagent?: (input: {
    readonly subagentId: string;
    readonly executionId: string;
  }) => void;
}): ReactElement {
  const { runtime, view, storeSnapshot, interactions } = props;
  const sessionId = view.activeSession?.id ?? null;
  const commandModalNotice = useMemo(
    () =>
      [...view.commandNotices]
        .reverse()
        .find((notice) => createCommandResultModel(notice) !== null) ?? null,
    [view.commandNotices],
  );
  return (
    <div className="ohb-root-conversation" tabIndex={-1}>
      <DurationSampleContext.Provider value={storeSnapshot.durationSample}>
        <ConversationPresentation.Provider
          value={{
            renderTool: (message, call, result) => {
              const execution = delegationExecution(
                message,
                call,
                interactions.subagentState.list?.executions ?? [],
                sessionId ?? "",
              );
              if (!isDelegationCall(call, execution)) return undefined;
              const instances = props.subagentInstances;
              const instance =
                execution && instances
                  ? findInstance(instances, execution.subagentId)
                  : undefined;
              return (
                <DelegationRow
                  call={call}
                  result={result}
                  execution={execution}
                  instanceName={instance?.displayName}
                  available={
                    !delegationNotStarted(message, call) &&
                    !(
                      execution &&
                      instances &&
                      isClosedInstance(instances, execution.subagentId)
                    )
                  }
                  onOpen={props.onOpenSubagent}
                />
              );
            },
          }}
        >
          <ConversationStream
            unconsumedSteers={getUnconsumedSteers(view.activeSession)}
            historyState={storeSnapshot.historyState}
            historyHasMore={storeSnapshot.historyHasMore}
            historyStale={storeSnapshot.historyStale}
            historyError={storeSnapshot.historyError}
            onLoadHistory={() => runtime.loadEarlierHistory()}
            promptRows={props.promptProjection.rows}
            startupThinkingAt={props.promptProjection.startupThinkingAt}
            messages={view.activeSession?.messages ?? []}
            sessionId={sessionId}
            prompts={(view.snapshot?.prompts ?? []).filter(
              (prompt) => prompt.sessionId === sessionId,
            )}
            activeRun={view.snapshot?.runs.find(
              (run) =>
                run.sessionId === view.composer.activeSessionId &&
                run.id === view.composer.activeRunId,
            )}
            isRunning={
              view.composer.isRunning &&
              !interactions.subagentState.list?.waiting
            }
            reasoningByMessageId={view.reasoningByMessageId}
            compacting={props.compacting}
            compactNotice={props.compactNotice}
            commandNotices={
              <CommandNoticeList
                notices={view.commandNotices.filter(
                  (notice) => notice.kind === "success",
                )}
                onClose={(id) => {
                  runtime.store.consumeCommand(id);
                }}
              />
            }
          />
        </ConversationPresentation.Provider>
      </DurationSampleContext.Provider>
      {commandModalNotice ? (
        <CommandResultModal
          header={view.header}
          notice={commandModalNotice}
          onClose={() => {
            runtime.store.consumeCommand(commandModalNotice.id);
          }}
          onInsertSkill={(text) => {
            props.onInsertSkill(text);
            runtime.store.consumeCommand(commandModalNotice.id);
          }}
          view={{
            activeSession: view.activeSession
              ? { title: view.activeSession.title }
              : null,
            composer: {
              activeSessionId: view.composer.activeSessionId,
              mode: view.composer.mode,
              permissionLevel: view.composer.permissionLevel,
            },
          }}
        />
      ) : null}
    </div>
  );
}
