import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Search } from "lucide-react";
import type { UiGlobalSession } from "ohbaby-sdk";
import { trapTab } from "../shared/focus-trap.js";
import { Spinner } from "../shared/Spinner.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";
import { highlightKeywords, relativeAge } from "./search-text.js";
import { useSessionSearch, type SessionSearch } from "./useSessionSearch.js";

/** What a chosen row opens: a body hit carries the message to jump to. */
export interface SearchSelection {
  readonly session: UiGlobalSession;
  readonly messageId?: string;
}

interface Row {
  readonly session: UiGlobalSession;
  readonly messageId?: string;
  readonly snippet?: string;
}

const RECENT_LIMIT = 10;

/**
 * The centered search card (session-search 02 §3). Focus stays in the input;
 * arrows move the selected row and Enter opens it. An empty query lists the
 * latest chats; a query searches titles and message bodies on the server.
 */
export function SearchDialog(props: {
  readonly search: SessionSearch;
  /** The global list, newest first; the first ten become Recent. */
  readonly recent: readonly UiGlobalSession[];
  readonly activeSessionId: string | null;
  readonly onSelect: (selection: SearchSelection) => void;
  readonly onClose: () => void;
}): ReactElement {
  const state = useSessionSearch(props.search);
  const listId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searching = state.query.trim() !== "";
  const rows: readonly Row[] = searching
    ? state.results.map((result) => ({
        session: result.session,
        // A body hit is one with a message; its snippet is body text only.
        ...(result.messageId
          ? { messageId: result.messageId, snippet: result.snippet }
          : {}),
      }))
    : props.recent
        .filter((session) => session.status === "active")
        .slice(0, RECENT_LIMIT)
        .map((session) => ({ session }));
  const [selected, setSelected] = useState(0);
  const clampedSelected = Math.min(selected, Math.max(0, rows.length - 1));
  const activeOption =
    rows.length > 0 ? optionId(listId, clampedSelected) : undefined;

  // A new query or order starts the selection over at the first row.
  useEffect(() => {
    setSelected(0);
  }, [state.query, state.order]);

  useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    inputRef.current?.focus();
    return (): void => {
      previous?.focus({ preventScroll: true });
    };
  }, []);

  // The sentinel under the list loads the next page whenever it shows,
  // including when the first page is too short to scroll.
  const { nextCursor, loading, error, loadMore } = state;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !sentinel ||
      !nextCursor ||
      loading ||
      error ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: scrollRef.current, rootMargin: "0px 0px 120px 0px" },
    );
    observer.observe(sentinel);
    return (): void => {
      observer.disconnect();
    };
  }, [nextCursor, loading, error, loadMore]);

  const choose = (row: Row | undefined): void => {
    if (!row) return;
    props.onSelect({
      session: row.session,
      ...(row.messageId ? { messageId: row.messageId } : {}),
    });
  };
  return createPortal(
    <div
      className="ohb-search-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ohb-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search chats"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onClose();
            return;
          }
          trapTab(event, dialogRef.current);
        }}
      >
        <div className="ohb-search-head">
          <Search aria-hidden="true" size={17} className="ohb-search-glyph" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search chats"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeOption}
            placeholder="Search chats"
            autoComplete="off"
            spellCheck={false}
            value={state.query}
            onChange={(event) => {
              state.setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (rows.length === 0) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                const next = Math.max(
                  0,
                  Math.min(rows.length - 1, clampedSelected + step),
                );
                setSelected(next);
                // The rows are already there; keep the new one in view.
                document
                  .getElementById(optionId(listId, next))
                  ?.scrollIntoView({ block: "nearest" });
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(rows[clampedSelected]);
              }
            }}
          />
          {searching ? (
            <button
              type="button"
              className="ohb-search-order"
              aria-label={
                state.order === "desc"
                  ? "Newest first. Show oldest first"
                  : "Oldest first. Show newest first"
              }
              onClick={() => {
                state.toggleOrder();
                inputRef.current?.focus();
              }}
            >
              {state.order === "desc" ? "Newest" : "Oldest"}
            </button>
          ) : null}
        </div>
        <div ref={scrollRef} className="ohb-search-body">
          {rows.length > 0 ? (
            <p className="ohb-search-label" aria-hidden="true">
              {searching ? "Chats" : "Recent"}
            </p>
          ) : null}
          <ul id={listId} role="listbox" aria-label="Chats">
            {rows.map((row, index) => {
              const workspace = row.session.workspaceDirectory
                ? workspaceLabel(row.session.workspaceDirectory)
                : null;
              return (
                <li
                  key={row.session.id}
                  id={optionId(listId, index)}
                  role="option"
                  aria-selected={index === clampedSelected}
                  aria-current={
                    row.session.id === props.activeSessionId
                      ? "page"
                      : undefined
                  }
                  className="ohb-search-row"
                  onMouseMove={() => {
                    if (index !== clampedSelected) setSelected(index);
                  }}
                  onMouseDown={(event) => {
                    // Keep focus, and with it the keyboard, in the input.
                    event.preventDefault();
                  }}
                  onClick={() => {
                    choose(row);
                  }}
                >
                  <MessageCircle
                    aria-hidden="true"
                    size={15}
                    className="ohb-search-row-icon"
                  />
                  <span className="ohb-search-row-title">
                    {highlightKeywords(row.session.title, state.query)}
                  </span>
                  <span className="ohb-search-row-meta">
                    {workspace ? (
                      <span className="ohb-search-row-workspace">
                        {workspace}
                      </span>
                    ) : null}
                    <span className="ohb-search-row-age">
                      {relativeAge(row.session.updatedAt)}
                    </span>
                  </span>
                  {row.snippet ? (
                    <span className="ohb-search-row-snippet">
                      {highlightKeywords(row.snippet, state.query)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {searching && state.loading ? (
            <div className="ohb-search-status">
              <Spinner size={12} label="Searching chats" />
            </div>
          ) : null}
          {state.error ? (
            <div className="ohb-search-status" role="alert">
              <span>{state.error}</span>
              <button
                type="button"
                className="ohb-text-button"
                onClick={() => {
                  state.retry();
                  inputRef.current?.focus();
                }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {searching &&
          state.ready &&
          !state.loading &&
          !state.error &&
          rows.length === 0 ? (
            <p className="ohb-search-status">
              No chats match “{state.query.trim()}”
            </p>
          ) : null}
          {!searching && rows.length === 0 ? (
            <p className="ohb-search-status">No chats yet</p>
          ) : null}
          <div ref={sentinelRef} className="ohb-search-sentinel" />
        </div>
        <footer className="ohb-search-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Select
          </span>
          <span>
            <kbd className="ohb-search-enter">↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${String(index)}`;
}
