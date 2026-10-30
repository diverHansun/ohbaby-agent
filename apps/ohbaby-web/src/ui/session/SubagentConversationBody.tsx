import type { ReactElement } from "react";
import type {
  UiSubagentConversationReaderState,
  createSubagentConversationReader,
} from "ohbaby-sdk";
import {
  ConversationStream,
  type ConversationReadingPosition,
} from "../conversation/ConversationStream.js";
import { ConversationPresentation } from "../conversation/ConversationPresentation.js";

type Reader = ReturnType<typeof createSubagentConversationReader>;
export interface ReadingMemory {
  position: ConversationReadingPosition;
  tools: Map<string, boolean>;
}
export type SubagentReadingCache = Map<string, ReadingMemory>;

/** Reading position and expanded tools for one child, kept across reopenings. */
export function readingMemory(
  cache: SubagentReadingCache,
  identity: string,
): ReadingMemory {
  let memory = cache.get(identity);
  if (!memory) {
    memory = { position: { top: 0, sticky: false }, tools: new Map() };
    cache.set(identity, memory);
  }
  return memory;
}

/**
 * A child's read-only conversation and its status lines, as the right
 * panel's subagent detail shows it.
 */
export function SubagentConversationBody({
  reader,
  state,
  memory,
  identity,
  anchorToken,
  followAnchor = true,
  approvalRequired,
}: {
  readonly reader: Reader;
  readonly state: UiSubagentConversationReaderState;
  readonly memory: ReadingMemory;
  /** Keys the stream's reading position; `rootSessionId:subagentId`. */
  readonly identity: string;
  readonly anchorToken?: string;
  /** False when reopening a held conversation: keep the reading position instead. */
  readonly followAnchor?: boolean;
  readonly approvalRequired?: boolean;
}): ReactElement {
  const conversation = state.conversation;
  const selected = state.selected;
  return (
    <>
      {state.error ? (
        <p className="ohb-child-notice" role="alert">
          {state.error}{" "}
          <button type="button" onClick={() => void reader.refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {state.locating ? (
        <p className="ohb-child-notice" role="status">
          Locating delegation…
        </p>
      ) : null}
      {state.reconnecting ? (
        <p className="ohb-child-notice" role="status">
          Reconnecting…
        </p>
      ) : null}
      {conversation && !conversation.anchorFound ? (
        <p className="ohb-child-notice">
          This delegation’s original message is unavailable. Showing available
          conversation history.
        </p>
      ) : null}
      {approvalRequired ? (
        <p className="ohb-child-notice">Approval required</p>
      ) : null}
      {conversation?.view.reasoningMissing ? (
        <p className="ohb-child-notice">
          Some thinking could not be saved and is unavailable.
        </p>
      ) : null}
      <ConversationPresentation.Provider
        value={{
          fromParent: true,
          executions: conversation?.executions,
          tools: memory.tools,
        }}
      >
        <ConversationStream
          preserveMessageOrder
          readingPosition={memory.position}
          anchorMessageId={
            state.locating || !followAnchor
              ? undefined
              : conversation?.anchorMessageId
          }
          anchorToken={anchorToken ?? selected?.executionId}
          onNearEnd={
            conversation?.history.hasLater && !state.loading
              ? (): void => {
                  void reader.loadLater();
                }
              : undefined
          }
          historyState={
            state.error ? "error" : state.loading ? "loading" : "ready"
          }
          historyHasMore={conversation?.history.hasMore ?? false}
          historyStale={false}
          historyError={state.error}
          onLoadHistory={() => reader.loadEarlier()}
          promptRows={[]}
          messages={conversation?.messages ?? []}
          sessionId={identity}
          prompts={[]}
          activeRun={conversation?.view.runs.find(
            (run) => run.status.kind === "running",
          )}
          isRunning={false}
          reasoningByMessageId={{}}
          commandNotices={
            conversation?.messages.length === 0 &&
            conversation.storedResult !== undefined ? (
              <section className="ohb-child-stored-result">
                <h3>Stored result</h3>
                <pre>{conversation.storedResult}</pre>
              </section>
            ) : conversation?.history.hasLater ? (
              <div className="ohb-child-gap" role="status">
                More messages below{" "}
                <button
                  type="button"
                  disabled={state.loading}
                  onClick={() => void reader.loadLater()}
                >
                  Load later messages
                </button>
              </div>
            ) : null
          }
        />
      </ConversationPresentation.Provider>
    </>
  );
}
