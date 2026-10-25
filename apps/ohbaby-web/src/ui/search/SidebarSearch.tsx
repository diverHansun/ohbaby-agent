import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UiGlobalSession } from "ohbaby-sdk";
import { Spinner } from "../shared/Spinner.js";
import { useSessionSearch, type SessionSearch } from "./useSessionSearch.js";

export interface SidebarSearchProps {
  readonly open: boolean;
  readonly focusRequest?: number;
  readonly search: SessionSearch;
  readonly activeSessionId: string | null;
  readonly onSelect: (session: UiGlobalSession) => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let start = 0;
  let index = lower.indexOf(needle);
  while (index >= 0) {
    parts.push(
      text.slice(start, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    start = index + query.length;
    index = lower.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return parts;
}
export function SidebarSearch(props: SidebarSearchProps): ReactNode {
  const state = useSessionSearch(props.open, props.search);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const [selected, setSelected] = useState(-1);
  useEffect(() => {
    if (props.open) input.current?.focus();
  }, [props.open, props.focusRequest]);
  useEffect(() => {
    setSelected(-1);
  }, [state.query]);
  function focusRow(index: number): void {
    const next = Math.max(0, Math.min(state.results.length - 1, index));
    setSelected(next);
    rows.current[next]?.focus();
    rows.current[next]?.scrollIntoView?.({ block: "nearest" });
  }
  if (!props.open) return props.children;
  return (
    <>
      <div
        className="ohb-session-search"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            event.preventDefault();
            props.onClose();
          }
        }}
      >
        <input
          ref={input}
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={state.query}
          onChange={(event) => {
            state.setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              focusRow(selected + (event.key === "ArrowDown" ? 1 : -1));
            } else if (event.key === "Enter" && state.results[selected]) {
              event.preventDefault();
              props.onSelect(state.results[selected].session);
            }
          }}
        />
        {state.query.trim() && (
          <div
            className="ohb-session-search-results"
            aria-label="Search results"
          >
            {state.loading && <Spinner size={12} label="Searching chats" />}
            {state.results.map((result, index) => (
              <button
                key={result.session.id}
                ref={(element) => {
                  rows.current[index] = element;
                }}
                onFocus={() => {
                  setSelected(index);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
                  }
                }}
                type="button"
                className="ohb-session-search-row"
                data-selected={index === selected || undefined}
                aria-current={
                  result.session.id === props.activeSessionId
                    ? "page"
                    : undefined
                }
                onClick={() => {
                  props.onSelect(result.session);
                }}
              >
                <span className="ohb-session-search-title">
                  {highlight(result.session.title, state.query)}
                </span>
                {result.matchType === "message" && (
                  <span className="ohb-session-search-snippet">
                    {highlight(result.snippet, state.query)}
                  </span>
                )}
              </button>
            ))}
            {state.error && (
              <div role="alert">
                {state.error}
                <button type="button" onClick={state.retry}>
                  Retry
                </button>
              </div>
            )}
            {state.ready &&
              !state.loading &&
              !state.error &&
              state.results.length === 0 && (
                <p>No chats match &quot;{state.query}&quot;.</p>
              )}
            {state.nextCursor && !state.error && (
              <button
                type="button"
                disabled={state.loading}
                onClick={state.loadMore}
              >
                Show more results
              </button>
            )}
          </div>
        )}
      </div>
      {!state.query.trim() && props.children}
    </>
  );
}
