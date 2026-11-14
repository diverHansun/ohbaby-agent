import type { UiBackendClient, UiShellJobRow } from "ohbaby-sdk";
import { ArrowDown, ChevronLeft } from "lucide-react";
import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CopyButton } from "../../shared/CopyButton.js";
import { readableError } from "../../shared/error-text.js";
import { IconButton } from "../../shared/IconButton.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { TaskCancelButton } from "./TaskCancelButton.js";
import {
  canCancel,
  taskNotes,
  taskOutputView,
  taskStatusLine,
  taskTitle,
} from "./task-view.js";
import { useTaskOutput } from "./use-task-output.js";

/** Leaving the bottom by less than this keeps following (04 §1.4). */
const FOLLOW_SLACK_PX = 24;

/**
 * One task (03 §4.2): a fixed header with its status, command and notes, and
 * the output tail below, which follows new output until scrolled up.
 */
export function BackgroundTaskDetail(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly jobId: string;
  /** The row from the list, when it is loaded; the output read carries it too. */
  readonly row?: UiShellJobRow;
  readonly now: number;
  readonly cancelling: boolean;
  readonly cancelError?: string;
  readonly stopRefusal?: "not-found" | "other-backend";
  readonly onCancel: (row: UiShellJobRow) => void;
  readonly onBack: () => void;
  readonly onNotFound: (jobId: string) => void;
  /** Opened from the list (not from the chat), so focus moves in here. */
  readonly takeFocus: boolean;
  /** Reports the freshest row, so the page can settle `Cancelling…`. */
  readonly onRow?: (row: UiShellJobRow) => void;
}): ReactElement {
  const { jobId, onNotFound, stopRefusal } = props;
  const unavailable = stopRefusal === "not-found";
  const output = useTaskOutput(
    props.client,
    props.rootSessionId,
    props.jobId,
    !unavailable,
  );
  const { retry } = output;
  useEffect(() => {
    if (output.notFound && !unavailable) onNotFound(jobId);
  }, [jobId, onNotFound, output.notFound, unavailable]);
  const previousRefusal = useRef(stopRefusal);
  useEffect(() => {
    if (
      stopRefusal === "other-backend" &&
      previousRefusal.current !== stopRefusal
    )
      retry();
    previousRefusal.current = stopRefusal;
  }, [retry, stopRefusal]);
  // The list can observe a stop before the next output read.
  const observedJob =
    props.row && props.row.status !== "running"
      ? props.row
      : (output.output?.job ?? props.row);
  const canStillStop =
    stopRefusal !== "other-backend" && props.row?.canStop !== false;
  const job =
    observedJob && stopRefusal === "other-backend"
      ? { ...observedJob, canStop: false, managedByCurrentBackend: false }
      : observedJob;
  const { onRow } = props;
  useLayoutEffect(() => {
    if (observedJob) onRow?.(observedJob);
  }, [observedJob, onRow]);
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (props.takeFocus) back.current?.focus({ preventScroll: true });
  }, [props.takeFocus, props.jobId]);

  const scroller = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  const text = output.output?.output;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [text, following]);
  const notFound = unavailable || output.notFound;
  const showLoading = useDelayed(!job && !notFound, 300);

  if (notFound)
    return (
      <section className="ohb-bgtask-detail">
        <header className="ohb-bgtask-detail-header">
          <IconButton ref={back} label="Back to tasks" onClick={props.onBack}>
            <ChevronLeft aria-hidden="true" size={16} />
          </IconButton>
        </header>
        <p className="ohb-side-notice">This task is no longer available.</p>
      </section>
    );
  if (!job)
    return (
      <section className="ohb-bgtask-detail">
        <header className="ohb-bgtask-detail-header">
          <IconButton ref={back} label="Back to tasks" onClick={props.onBack}>
            <ChevronLeft aria-hidden="true" size={16} />
          </IconButton>
        </header>
        {output.error ? (
          <p className="ohb-side-notice" role="alert">
            {readableError(output.error)}{" "}
            <button type="button" onClick={output.retry}>
              Retry
            </button>
          </p>
        ) : showLoading ? (
          <p className="ohb-side-notice" role="status">
            Loading…
          </p>
        ) : null}
      </section>
    );

  const title = taskTitle(job);
  const notes = taskNotes(job);
  const view = output.output ? taskOutputView(output.output) : undefined;
  const ended = job.status !== "running";
  return (
    <section className="ohb-bgtask-detail" aria-label={title}>
      <header className="ohb-bgtask-detail-header">
        <IconButton ref={back} label="Back to tasks" onClick={props.onBack}>
          <ChevronLeft aria-hidden="true" size={16} />
        </IconButton>
        <h2 title={title}>{title}</h2>
        {canStillStop && canCancel(job) ? (
          <TaskCancelButton
            title={title}
            cancelling={props.cancelling}
            onCancel={() => {
              props.onCancel(job);
            }}
          />
        ) : null}
      </header>
      <div className="ohb-bgtask-detail-meta">
        <p
          className={`ohb-bgtask-detail-status${
            job.status === "failed" || job.status === "timed_out"
              ? " is-failed"
              : ""
          }`}
        >
          {taskStatusLine(job, props.now)}
        </p>
        <p className="ohb-bgtask-detail-command">{job.command}</p>
        {job.ownerKind === "subagent" ? (
          <p className="ohb-bgtask-detail-note">Started by {job.ownerName}</p>
        ) : null}
        {notes.map((note) => (
          <p key={note} className="ohb-bgtask-detail-note">
            {note}
          </p>
        ))}
      </div>
      {props.cancelError ? (
        <p className="ohb-side-notice" role="alert">
          {readableError(props.cancelError)}
        </p>
      ) : null}
      {output.error ? (
        <p className="ohb-side-notice" role="alert">
          {readableError(output.error)}{" "}
          <button type="button" onClick={output.retry}>
            Retry
          </button>
        </p>
      ) : null}
      <div className="ohb-bgtask-output">
        {view && (view.tailOnly || view.logIncomplete) ? (
          <div className="ohb-bgtask-output-notes">
            <div>
              {view.tailOnly ? <p>Showing the last 32 KB.</p> : null}
              {view.logIncomplete ? (
                <p>
                  The saved log is incomplete because the output was too large.
                </p>
              ) : null}
            </div>
            {view.logPath ? (
              <CopyButton
                text={view.logPath}
                label="Copy log path"
                copiedLabel="Log path copied"
              />
            ) : null}
          </div>
        ) : null}
        {view?.noSavedOutput && ended ? (
          <p className="ohb-bgtask-output-empty">
            No output was saved for this task.
          </p>
        ) : view?.text === "" && ended ? (
          <p className="ohb-bgtask-output-empty">No output.</p>
        ) : (
          <pre
            ref={scroller}
            className="ohb-bgtask-output-text"
            tabIndex={0}
            aria-label="Output"
            onScroll={(event) => {
              const element = event.currentTarget;
              const atBottom =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                FOLLOW_SLACK_PX;
              if (atBottom !== following) setFollowing(atBottom);
            }}
          >
            {text}
          </pre>
        )}
        {!following ? (
          <IconButton
            label="Scroll to latest output"
            className="ohb-bgtask-output-latest"
            onClick={() => {
              setFollowing(true);
            }}
          >
            <ArrowDown aria-hidden="true" size={14} />
          </IconButton>
        ) : null}
      </div>
    </section>
  );
}
