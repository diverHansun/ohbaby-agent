import type {
  UiSubagentInstance,
  UiSubagentInstanceReaderState,
} from "ohbaby-sdk";
import { ChevronRight } from "lucide-react";
import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
import { readableError } from "../../shared/error-text.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { useMinuteClock } from "../../shared/use-minute-clock.js";
import { relativeTime } from "../../sidebar/relative-time.js";
import { groupInstances } from "./instance-status.js";
import { InstanceStatus } from "./InstanceStatus.js";

function unprocessedText(count: number): string {
  return count === 1
    ? "1 unprocessed message"
    : `${String(count)} unprocessed messages`;
}

function InstanceRow(props: {
  readonly instance: UiSubagentInstance;
  readonly now: number;
  readonly onSelect: (subagentId: string) => void;
}): ReactElement {
  const { instance } = props;
  return (
    <li>
      <button
        type="button"
        className="ohb-subagent-instance"
        data-subagent-id={instance.subagentId}
        onClick={() => {
          props.onSelect(instance.subagentId);
        }}
      >
        <span className="ohb-subagent-instance-line">
          <span className="ohb-subagent-instance-name">
            {instance.displayName}
          </span>
          <InstanceStatus instance={instance} />
        </span>
        <span className="ohb-subagent-instance-line">
          <span className="ohb-subagent-instance-description">
            {instance.description}
          </span>
          <small>
            {relativeTime(
              new Date(instance.updatedAt).toISOString(),
              props.now,
            )}
          </small>
        </span>
        {instance.unprocessedMessageCount > 0 ? (
          <span className="ohb-subagent-instance-note">
            {unprocessedText(instance.unprocessedMessageCount)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function InstanceGroup(props: {
  readonly title: string;
  readonly instances: readonly UiSubagentInstance[];
  readonly now: number;
  readonly onSelect: (subagentId: string) => void;
}): ReactElement {
  // Collapsing is a reading convenience only (like Claude's task groups).
  const [open, setOpen] = useState(true);
  return (
    <section className="ohb-subagent-group" aria-label={props.title}>
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
          {props.title}
          <span className="ohb-subagent-group-count">
            {props.instances.length}
          </span>
        </button>
      </h3>
      {!open ? null : props.instances.length === 0 ? (
        <p className="ohb-subagent-group-empty">None</p>
      ) : (
        <ul>
          {props.instances.map((instance) => (
            <InstanceRow
              key={instance.subagentId}
              instance={instance}
              now={props.now}
              onSelect={props.onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Subagents list (03 §4.9, 04 §2.7): one row per open instance, grouped
 * into Active and Done. A failed refresh keeps the last list.
 */
export function SubagentInstanceList(props: {
  readonly state: UiSubagentInstanceReaderState;
  readonly onSelect: (subagentId: string) => void;
  readonly onRetry: () => void;
  /** After returning from a detail: focus that row, or the list when it is gone. */
  readonly focusSubagentId?: string;
}): ReactElement {
  const { snapshot, error, loading } = props.state;
  const now = useMinuteClock();
  const list = useRef<HTMLDivElement>(null);
  const { focusSubagentId } = props;
  useLayoutEffect(() => {
    if (focusSubagentId === undefined || !list.current) return;
    const row = [
      ...list.current.querySelectorAll<HTMLElement>("[data-subagent-id]"),
    ].find((element) => element.dataset.subagentId === focusSubagentId);
    (row ?? list.current).focus({ preventScroll: true });
  }, [focusSubagentId]);
  const showLoading = useDelayed(loading && !snapshot, 300);
  const errorLine = error ? (
    <p className="ohb-side-notice" role="alert">
      {readableError(error)}{" "}
      <button type="button" onClick={props.onRetry}>
        Retry
      </button>
    </p>
  ) : null;
  if (!snapshot)
    return (
      <div className="ohb-subagent-list" ref={list} tabIndex={-1}>
        {errorLine}
        {showLoading && !error ? (
          <p className="ohb-side-notice" role="status">
            Loading…
          </p>
        ) : null}
      </div>
    );
  const groups = groupInstances(snapshot.instances);
  return (
    <div className="ohb-subagent-list" ref={list} tabIndex={-1}>
      {errorLine}
      {snapshot.instances.length === 0 ? (
        <p className="ohb-side-notice">No subagents in this chat.</p>
      ) : (
        <>
          <InstanceGroup
            title="Active"
            instances={groups.active}
            now={now}
            onSelect={props.onSelect}
          />
          <InstanceGroup
            title="Done"
            instances={groups.done}
            now={now}
            onSelect={props.onSelect}
          />
        </>
      )}
    </div>
  );
}
