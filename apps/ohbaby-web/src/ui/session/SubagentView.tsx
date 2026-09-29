import { Maximize2, Minimize2, X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactElement } from "react";
import type {
  UiSubagentConversationReaderState,
  createSubagentConversationReader,
} from "ohbaby-sdk";
import {
  ConversationStream,
  type ConversationReadingPosition,
} from "../conversation/ConversationStream.js";
import { ConversationPresentation } from "../conversation/ConversationPresentation.js";

import { subagentStatusLabel } from "./DelegationRow.js";

type Reader = ReturnType<typeof createSubagentConversationReader>;
export type SubagentReadingCache = Map<
  string,
  {
    position: ConversationReadingPosition;
    tools: Map<string, boolean>;
  }
>;
export function SubagentView({
  reader,
  readingCache,
  state,
  rootTitle,
  title,
  expanded,
  onExpandedChange,
  onClose,
  approvalRequired,
  anchorToken,
}: {
  readonly reader: Reader;
  readonly readingCache: SubagentReadingCache;
  readonly state: UiSubagentConversationReaderState;
  readonly rootTitle: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly onExpandedChange: (value: boolean) => void;
  readonly onClose: () => void;
  readonly approvalRequired?: boolean;
  readonly anchorToken?: string;
}): ReactElement {
  const conversation = state.conversation;
  const selected = state.selected;
  const identity = `${selected?.rootSessionId ?? ""}:${selected?.subagentId ?? ""}`;
  let memory = readingCache.get(identity);
  if (!memory) {
    memory = { position: { top: 0, sticky: false }, tools: new Map() };
    readingCache.set(identity, memory);
  }
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [identity, anchorToken]);
  const execution =
    conversation?.executions.find(
      (item) => item.executionId === selected?.executionId,
    ) ?? selected;
  return (
    <section
      className={`ohb-subagent-view${expanded ? " is-expanded" : ""}`}
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (expanded) onExpandedChange(false);
          else onClose();
        }
        if (event.key === "Tab") {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],summary,[tabindex="0"]',
            ),
          ].filter((node) => !node.closest("[hidden]"));
          const first = controls[0],
            last = controls.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === heading.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <header className="ohb-subagent-heading">
        <div className="ohb-subagent-title">
          {expanded ? (
            <nav aria-label="Conversation path">
              <button type="button" onClick={onClose}>
                {rootTitle}
              </button>
              <span aria-hidden="true">›</span>
            </nav>
          ) : null}
          <h2 ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <span className="ohb-subagent-status" role="status">
            {execution ? subagentStatusLabel(execution.status) : undefined}
          </span>
        </div>
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          onClick={() => {
            onExpandedChange(!expanded);
          }}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
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
            state.locating ? undefined : conversation?.anchorMessageId
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
      {expanded ? (
        <footer className="ohb-child-footer">Read-only</footer>
      ) : null}
    </section>
  );
}
