import type { UiShellJobListReaderState, UiShellJobRow } from "ohbaby-sdk";
import { Check, ChevronRight, ListFilter } from "lucide-react";
import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { readableError } from "../../shared/error-text.js";
import { IconButton } from "../../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../../shared/Menu.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { TaskCancelButton } from "./TaskCancelButton.js";
import {
  canCancel,
  groupCounts,
  taskGroup,
  taskTitle,
  taskTrailing,
  type TaskGroup,
} from "./task-view.js";

export type TaskOwnerFilter = "main" | "subagents" | "all";

const FILTER_LABELS: Record<TaskOwnerFilter, string> = {
  main: "Main agent",
  subagents: "Subagents",
  all: "All",
};

const EMPTY_TEXT: Record<TaskOwnerFilter, string> = {
  main: "No tasks from the main agent.",
  subagents: "No tasks from subagents.",
  all: "No background tasks in this chat.",
};

function TaskRow(props: {
  readonly row: UiShellJobRow;
  readonly now: number;
  readonly showOwner: boolean;
  readonly cancelling: boolean;
  readonly onSelect: (jobId: string) => void;
  readonly onCancel: (row: UiShellJobRow) => void;
}): ReactElement {
  const { row } = props;
  const title = taskTitle(row);
  const trailing = taskTrailing(row, props.now);
  return (
    <li className="ohb-bgtask-row" data-job-id={row.jobId}>
      <button
        type="button"
        className="ohb-bgtask-row-open"
        aria-label={`${title}, ${trailing.text}`}
        onClick={() => {
          props.onSelect(row.jobId);
        }}
      >
        <span className="ohb-bgtask-row-title">{title}</span>
        <span className="ohb-bgtask-row-command">{row.command}</span>
        {props.showOwner && row.ownerKind === "subagent" ? (
          <span className="ohb-bgtask-row-owner">{row.ownerName}</span>
        ) : null}
      </button>
      {/* Time and Cancel line up with the title, as in Claude's task pane. */}
      <span className="ohb-bgtask-row-side">
        <span
          className={`ohb-bgtask-row-trailing is-${trailing.kind}`}
          aria-hidden="true"
        >
          {trailing.text}
        </span>
        {canCancel(row) ? (
          <TaskCancelButton
            title={title}
            cancelling={props.cancelling}
            onCancel={() => {
              props.onCancel(row);
            }}
          />
        ) : null}
      </span>
    </li>
  );
}

function TaskGroupSection(props: {
  readonly group: TaskGroup;
  readonly count: number;
  readonly rows: readonly UiShellJobRow[];
  readonly render: (row: UiShellJobRow) => ReactElement;
}): ReactElement {
  // Folding is a reading convenience only; a new chat starts unfolded (04 §1.3).
  const [open, setOpen] = useState(true);
  const title = props.group === "running" ? "Running" : "Done";
  return (
    <section className="ohb-bgtask-group" aria-label={title}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <ChevronRight
            aria-hidden="true"
            size={12}
            className={open ? "is-open" : undefined}
          />
          {title}
          <span className="ohb-bgtask-group-count">{props.count}</span>
        </button>
      </h3>
      {!open ? null : props.rows.length === 0 ? (
        <p className="ohb-bgtask-group-empty">None</p>
      ) : (
        <ul>{props.rows.map(props.render)}</ul>
      )}
    </section>
  );
}

/**
 * The Background tasks list (03 §4.1): Running and Done groups with the
 * backend's counts, flat rows, a Cancel text button on running rows. More
 * done tasks load as the end of the list scrolls into view (D11).
 */
export function BackgroundTaskList(props: {
  readonly state: UiShellJobListReaderState;
  /** Keeps the scroll position and open groups while a detail is shown. */
  readonly hidden: boolean;
  readonly now: number;
  readonly filter: TaskOwnerFilter;
  /** Shown only when subagents have tasks too. */
  readonly showFilter: boolean;
  readonly onFilter: (filter: TaskOwnerFilter) => void;
  readonly cancelling: ReadonlySet<string>;
  readonly cancelError?: string;
  readonly onCancel: (row: UiShellJobRow) => void;
  readonly onSelect: (jobId: string) => void;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  /** After returning from a detail: focus that row, or the list when it is gone. */
  readonly focusJobId?: string;
}): ReactElement {
  const { rows, meta, loading, loadingMore, error, moreError } = props.state;
  const list = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const { focusJobId, onLoadMore, hidden } = props;
  useLayoutEffect(() => {
    if (hidden || focusJobId === undefined || !list.current) return;
    const row = [
      ...list.current.querySelectorAll<HTMLElement>("[data-job-id]"),
    ].find((element) => element.dataset.jobId === focusJobId);
    (
      row?.querySelector<HTMLElement>(".ohb-bgtask-row-open") ?? list.current
    ).focus();
  }, [focusJobId, hidden]);
  const canLoadMore =
    !hidden &&
    meta?.hasMore === true &&
    !loadingMore &&
    moreError === undefined;
  useEffect(() => {
    const root = list.current;
    const target = end.current;
    if (
      !root ||
      !target ||
      !canLoadMore ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      // Start about a screen early, so scrolling rarely meets the end.
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  }, [canLoadMore, onLoadMore, rows?.length]);
  const showLoading = useDelayed(loading && !rows, 300);
  const showMoreLoading = useDelayed(loadingMore, 300);
  const render = (row: UiShellJobRow): ReactElement => (
    <TaskRow
      key={row.jobId}
      row={row}
      now={props.now}
      showOwner={props.filter !== "main"}
      cancelling={props.cancelling.has(row.jobId)}
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
  const counts = meta ? groupCounts(meta.statusCounts) : undefined;
  const running = rows?.filter((row) => taskGroup(row) === "running") ?? [];
  const done = rows?.filter((row) => taskGroup(row) === "done") ?? [];
  return (
    <div className="ohb-bgtask-list" hidden={hidden} ref={list} tabIndex={-1}>
      {props.showFilter ? (
        <div className="ohb-bgtask-toolbar">
          <IconButton
            ref={filterButton}
            label={`Filter: ${FILTER_LABELS[props.filter]}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            className={props.filter === "main" ? undefined : "is-active"}
            onClick={(event) => {
              setMenu(menu ? null : anchorBelow(event.currentTarget));
            }}
          >
            <ListFilter aria-hidden="true" size={14} />
          </IconButton>
        </div>
      ) : null}
      {error ? (
        <p className="ohb-side-notice" role="alert">
          {readableError(error)}{" "}
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      {props.cancelError ? (
        <p className="ohb-side-notice" role="alert">
          {readableError(props.cancelError)}
        </p>
      ) : null}
      {!rows ? (
        showLoading && !error ? (
          <p className="ohb-side-notice" role="status">
            Loading…
          </p>
        ) : null
      ) : rows.length === 0 && !meta?.hasMore ? (
        <p className="ohb-side-notice">{EMPTY_TEXT[props.filter]}</p>
      ) : (
        <>
          <TaskGroupSection
            group="running"
            count={counts?.running ?? running.length}
            rows={running}
            render={render}
          />
          <TaskGroupSection
            group="done"
            count={counts?.done ?? done.length}
            rows={done}
            render={render}
          />
        </>
      )}
      {moreError ? (
        <p className="ohb-side-notice" role="alert">
          {readableError(moreError)}{" "}
          <button type="button" onClick={onLoadMore}>
            Retry
          </button>
        </p>
      ) : showMoreLoading ? (
        <p className="ohb-side-notice" role="status">
          Loading…
        </p>
      ) : null}
      <div ref={end} className="ohb-bgtask-list-end" aria-hidden="true" />
      {menu && !hidden ? (
        <Menu
          anchor={menu}
          label="Show tasks from"
          triggerRef={filterButton}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) filterButton.current?.focus();
          }}
        >
          {(Object.keys(FILTER_LABELS) as TaskOwnerFilter[]).map((filter) => (
            <button
              key={filter}
              type="button"
              role="menuitem"
              aria-current={filter === props.filter ? "true" : undefined}
              className="ohb-bgtask-filter-item"
              onClick={() => {
                setMenu(null);
                filterButton.current?.focus();
                props.onFilter(filter);
              }}
            >
              <span>{FILTER_LABELS[filter]}</span>
              {filter === props.filter ? (
                <Check aria-hidden="true" size={14} />
              ) : null}
            </button>
          ))}
        </Menu>
      ) : null}
    </div>
  );
}
