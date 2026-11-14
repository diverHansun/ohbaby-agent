import {
  createShellJobListReader,
  type UiBackendClient,
  type UiShellJobOwnerFilter,
  type UiShellJobRow,
} from "ohbaby-sdk";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BackgroundTaskProbe,
  useShellJobReaderState,
  useShellJobRefresh,
} from "../../shared/background-tasks.js";
import {
  isTimeout,
  STOP_REQUEST_TIMEOUT_MS,
} from "../../shared/stop-request.js";
import { BackgroundTaskDetail } from "./BackgroundTaskDetail.js";
import {
  BackgroundTaskList,
  type TaskOwnerFilter,
} from "./BackgroundTaskList.js";
import { errorCode } from "./use-task-output.js";

const PAGE_SIZE = 30;

function ownerQuery(
  filter: TaskOwnerFilter,
): UiShellJobOwnerFilter | undefined {
  return filter === "all" ? undefined : { kind: filter };
}

/** Starts on the main agent's tasks unless only subagents have any (06 §3.1). */
function defaultFilter(probe: BackgroundTaskProbe): TaskOwnerFilter {
  return probe.main === 0 && (probe.subagents ?? 0) > 0 ? "all" : "main";
}

/** Ticks every second while something runs, so running times move (06 §3.6). */
function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

/**
 * The Background tasks page: the list and one task's detail in the same tab.
 * It owns the list reader (kept while the detail shows, so going back is
 * instant) and which tasks are being cancelled. Unmounting it releases the
 * reads; it never stops a task.
 */
export function BackgroundTasksPage(props: {
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly selectedJobId?: string;
  readonly probe: BackgroundTaskProbe;
  readonly onSelect: (jobId: string | undefined) => void;
}): ReactElement {
  const { client, rootSessionId, probe, onSelect } = props;
  const [filter, setFilter] = useState<TaskOwnerFilter>(() =>
    defaultFilter(probe),
  );
  const [userFiltered, setUserFiltered] = useState(false);
  const reader = useMemo(
    () =>
      createShellJobListReader(client, {
        rootSessionId,
        owner: ownerQuery(filter),
        mode: "background",
        pageSize: PAGE_SIZE,
      }),
    // A new chat remounts the page; the filter switches through `select`,
    // so the reader is made once with the first filter.
    [client, rootSessionId],
  );
  useEffect(() => {
    void reader.refresh();
    return (): void => {
      reader.dispose();
    };
  }, [reader]);
  useShellJobRefresh(client, rootSessionId, () => {
    void reader.refresh();
  });
  const state = useShellJobReaderState(reader);
  const changeFilter = useCallback(
    (next: TaskOwnerFilter, byUser: boolean): void => {
      if (byUser) setUserFiltered(true);
      setFilter(next);
      void reader.select({
        rootSessionId,
        owner: ownerQuery(next),
        mode: "background",
        pageSize: PAGE_SIZE,
      });
    },
    [reader, rootSessionId],
  );
  // The probe may answer after the page opened: follow it until the user picks.
  useEffect(() => {
    if (!userFiltered && filter === "main" && defaultFilter(probe) === "all")
      changeFilter("all", false);
  }, [probe, userFiltered, filter, changeFilter]);

  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // A late answer reads this to see whether the list has settled the task.
  const cancellingRef = useRef(cancelling);
  cancellingRef.current = cancelling;
  const [cancelError, setCancelError] = useState<string>();
  const [stopRefusals, setStopRefusals] = useState<
    ReadonlyMap<string, "not-found" | "other-backend">
  >(() => new Map());
  const settle = useCallback((rows: readonly UiShellJobRow[]): void => {
    setStopRefusals((current) => {
      const observed = rows.filter(
        (row) =>
          current.get(row.jobId) === "other-backend" &&
          (row.status !== "running" || !row.canStop),
      );
      if (observed.length === 0) return current;
      const next = new Map(current);
      for (const row of observed) next.delete(row.jobId);
      return next;
    });
    setCancelling((current) => {
      const ended = rows.filter(
        (row) => current.has(row.jobId) && row.status !== "running",
      );
      if (ended.length === 0) return current;
      const next = new Set(current);
      for (const row of ended) next.delete(row.jobId);
      return next;
    });
  }, []);
  useEffect(() => {
    if (state.rows) settle(state.rows);
  }, [state.rows, settle]);
  const loadMore = useCallback((): void => {
    void reader.loadMore();
  }, [reader]);
  const settleOne = useCallback(
    (row: UiShellJobRow): void => {
      settle([row]);
    },
    [settle],
  );
  const markNotFound = useCallback(
    (jobId: string): void => {
      setStopRefusals((current) => new Map(current).set(jobId, "not-found"));
      void reader.refresh();
    },
    [reader],
  );
  const release = (jobId: string): void => {
    setCancelling((current) => {
      const next = new Set(current);
      next.delete(jobId);
      return next;
    });
  };
  const cancel = (row: UiShellJobRow): void => {
    if (cancelling.has(row.jobId) || stopRefusals.has(row.jobId)) return;
    setCancelling((current) => new Set(current).add(row.jobId));
    setCancelError(undefined);
    if (!client.stopShellJob) {
      release(row.jobId);
      setCancelError("Background tasks are unavailable");
      return;
    }
    client
      .stopShellJob({
        rootSessionId,
        jobId: row.jobId,
        signal: AbortSignal.timeout(STOP_REQUEST_TIMEOUT_MS),
      })
      .then((result) => {
        if (result.outcome === "already-terminal") release(row.jobId);
        else settle([result.job]);
      })
      .catch((error: unknown) => {
        const code = errorCode(error);
        if (
          code === "SHELL_JOB_OTHER_BACKEND" ||
          code === "SHELL_JOB_NOT_FOUND"
        ) {
          const refusal =
            code === "SHELL_JOB_NOT_FOUND" ? "not-found" : "other-backend";
          setStopRefusals((current) =>
            new Map(current).set(row.jobId, refusal),
          );
        } else if (code === "SHELL_JOB_CLEANUP_BUSY")
          setCancelError("ohbaby is already cleaning up this task.");
        else if (isTimeout(error)) {
          // The list may have seen the task end meanwhile; then there is
          // nothing to try again.
          if (cancellingRef.current.has(row.jobId))
            setCancelError("System didn't respond to Cancel. Try again.");
        } else if (code !== "SESSION_SCOPE_CHANGED")
          setCancelError(
            error instanceof Error ? error.message : String(error),
          );
        release(row.jobId);
      })
      .finally(() => {
        void reader.refresh();
      });
  };

  // Focus moves into a detail only when the list opened it (04 §3).
  const [openedFromList, setOpenedFromList] = useState<string>();
  const [returnFocus, setReturnFocus] = useState<string>();
  const selected = props.selectedJobId;
  const row = selected
    ? state.rows?.find((item) => item.jobId === selected)
    : undefined;
  const running =
    state.rows?.some((item) => item.status === "running") === true ||
    row?.status === "running";
  const now = useSecondClock(running || selected !== undefined);

  const listRows = stopRefusals.size
    ? state.rows?.flatMap((item) => {
        const refusal = stopRefusals.get(item.jobId);
        if (refusal === "not-found") return [];
        return [
          refusal === "other-backend" ? { ...item, canStop: false } : item,
        ];
      })
    : state.rows;
  return (
    <>
      <BackgroundTaskList
        hidden={selected !== undefined}
        state={listRows === state.rows ? state : { ...state, rows: listRows }}
        now={now}
        filter={filter}
        showFilter={(probe.subagents ?? 0) > 0 || filter !== "main"}
        onFilter={(next) => {
          if (next !== filter) changeFilter(next, true);
        }}
        cancelling={cancelling}
        cancelError={selected === undefined ? cancelError : undefined}
        onCancel={cancel}
        onSelect={(jobId) => {
          setOpenedFromList(jobId);
          setReturnFocus(undefined);
          setCancelError(undefined);
          onSelect(jobId);
        }}
        onRetry={() => {
          void reader.refresh();
        }}
        onLoadMore={loadMore}
        focusJobId={returnFocus}
      />
      {selected ? (
        <BackgroundTaskDetail
          key={selected}
          client={client}
          rootSessionId={rootSessionId}
          jobId={selected}
          row={row}
          now={now}
          cancelling={cancelling.has(selected)}
          cancelError={cancelError}
          stopRefusal={stopRefusals.get(selected)}
          onCancel={cancel}
          onNotFound={markNotFound}
          onRow={settleOne}
          takeFocus={openedFromList === selected}
          onBack={() => {
            setOpenedFromList(undefined);
            setReturnFocus(selected);
            setCancelError(undefined);
            onSelect(undefined);
          }}
        />
      ) : null}
    </>
  );
}
