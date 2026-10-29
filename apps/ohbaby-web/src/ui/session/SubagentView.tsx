import { Maximize2, Minimize2, X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactElement } from "react";
import type {
  UiSubagentConversationReaderState,
  createSubagentConversationReader,
} from "ohbaby-sdk";
import {
  readingMemory,
  SubagentConversationBody,
  type SubagentReadingCache,
} from "./SubagentConversationBody.js";
import { subagentStatusLabel } from "./DelegationRow.js";

type Reader = ReturnType<typeof createSubagentConversationReader>;
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
  const memory = readingMemory(readingCache, identity);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    // Collapsing removes the breadcrumb; keep keyboard navigation in the child.
    heading.current?.focus({ preventScroll: true });
  }, [identity, anchorToken, expanded]);
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
          ].filter(
            (node) =>
              !node.closest("[hidden]") &&
              (node.tagName === "SUMMARY" ||
                !node.closest("details:not([open])")),
          );
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
      <SubagentConversationBody
        reader={reader}
        state={state}
        memory={memory}
        identity={identity}
        anchorToken={anchorToken}
        approvalRequired={approvalRequired}
      />
      {expanded ? (
        <footer className="ohb-child-footer">Read-only</footer>
      ) : null}
    </section>
  );
}
