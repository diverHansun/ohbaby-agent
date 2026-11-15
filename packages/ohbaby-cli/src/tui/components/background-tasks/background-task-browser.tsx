import {
  taskTitle,
  type CoreAPI,
  type UiEventHandler,
  type UiShellJobRow,
  type UiUnsubscribe,
} from "ohbaby-sdk";
import { Box, Text, useInput } from "ink";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";
import { formatError } from "../../format-error.js";
import {
  canCancelRow,
  confirmLine,
  detailHeader,
  keyLine,
  outputLines,
  type Line,
  type OwnerFilter,
  PANEL_MIN_ROWS,
  PANEL_MIN_WIDTH,
  panelTitle,
  taskListModel,
  type Tone,
} from "./task-lines.js";
import {
  type BackgroundTaskProbe,
  errorCode,
  ownerQuery,
  TASK_PAGE_SIZE,
  useTaskList,
  useTaskOutput,
} from "./use-background-tasks.js";

/** How long `c` waits for `y` before giving up (T6). */
export const CONFIRM_TIMEOUT_MS = 5000;
const STOP_REQUEST_TIMEOUT_MS = 10_000;
const FILTER_ORDER: readonly OwnerFilter[] = ["main", "subagents", "all"];

function defaultFilter(probe: BackgroundTaskProbe): OwnerFilter {
  return probe.main === 0 && (probe.subagents ?? 0) > 0 ? "all" : "main";
}

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

/** True once `flag` stayed true for `delay` ms, so quick loads never flash. */
function useDelayed(flag: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => {
      setShown(true);
    }, delay);
    return (): void => {
      clearTimeout(timer);
    };
  }, [flag, delay]);
  return shown;
}

function LineView({ line }: { readonly line: Line }): ReactElement {
  const theme = useTheme();
  const color = (tone: Tone | undefined): string | undefined =>
    tone === "accent"
      ? theme.status.accent
      : tone === "error"
        ? theme.status.error
        : tone === "warning"
          ? theme.status.warning
          : undefined;
  return (
    <Text wrap="truncate-end">
      {line.map((segment, index) => (
        <Text
          key={String(index)}
          color={color(segment.tone)}
          dimColor={segment.tone === "dim"}
          bold={segment.tone === "bold"}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/** Keeps `index` inside a window of `height` rows over `total`. */
function windowStart(index: number, height: number, total: number): number {
  if (total <= height) return 0;
  return Math.min(Math.max(0, index - height + 1), total - height);
}

/**
 * The Background tasks panel (TUI 03 §4, 04): it replaces the conversation
 * like the subagent browser, with a list and one task's detail. It owns the
 * list reader, the cancel confirmation and which tasks are being cancelled;
 * closing it releases the reads and never stops a task.
 */
export function BackgroundTaskBrowser({
  client,
  subscribeEvents,
  rootSessionId,
  probe,
  approvalPending,
  onClose,
}: {
  readonly client: CoreAPI;
  readonly subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe;
  readonly rootSessionId: string;
  readonly probe: BackgroundTaskProbe;
  readonly approvalPending: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const layout = useTuiLayout();
  const width = Math.max(1, layout.contentWidth);
  const [filter, setFilter] = useState<OwnerFilter>(() => defaultFilter(probe));
  const [userFiltered, setUserFiltered] = useState(false);
  const { reader, state } = useTaskList(
    client,
    subscribeEvents,
    rootSessionId,
    ownerQuery(filter),
  );
  const changeFilter = useCallback(
    (next: OwnerFilter): void => {
      setFilter(next);
      void reader.select({
        rootSessionId,
        owner: ownerQuery(next),
        mode: "background",
        pageSize: TASK_PAGE_SIZE,
      });
    },
    [reader, rootSessionId],
  );
  // The probe may answer after the panel opened: follow it until the user picks.
  useEffect(() => {
    if (!userFiltered && filter === "main" && defaultFilter(probe) === "all")
      changeFilter("all");
  }, [probe, userFiltered, filter, changeFilter]);
  const filterable = (probe.subagents ?? 0) > 0 || filter !== "main";

  const [detailJobId, setDetailJobId] = useState<string>();
  const [selected, setSelected] = useState(0);
  // null follows the newest output; a number is the first shown output row.
  const [outputTop, setOutputTop] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{
    readonly jobId: string;
    readonly title: string;
  } | null>(null);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const cancellingRef = useRef(cancelling);
  cancellingRef.current = cancelling;
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => {
      setConfirm(null);
    }, CONFIRM_TIMEOUT_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [confirm]);

  const output = useTaskOutput(
    client,
    subscribeEvents,
    rootSessionId,
    detailJobId,
  );
  useEffect(() => {
    if (output.notFound) void reader.refresh();
  }, [output.notFound, reader]);
  const rows = state.rows ?? [];
  const listRow = detailJobId
    ? rows.find((row) => row.jobId === detailJobId)
    : undefined;
  // Whichever source already saw the task end is the fresher one.
  const detailRow: UiShellJobRow | undefined = output.notFound
    ? undefined
    : listRow && output.output
      ? listRow.status !== "running"
        ? listRow
        : output.output.job
      : (listRow ?? output.output?.job);

  const settle = useCallback((ended: readonly UiShellJobRow[]): void => {
    setCancelling((current) => {
      const done = ended.filter(
        (row) => current.has(row.jobId) && row.status !== "running",
      );
      if (done.length === 0) return current;
      const next = new Set(current);
      for (const row of done) next.delete(row.jobId);
      return next;
    });
  }, []);
  useEffect(() => {
    settle(detailRow ? [...rows, detailRow] : rows);
  }, [rows, detailRow, settle]);

  const running =
    rows.some((row) => row.status === "running") ||
    detailRow?.status === "running";
  const now = useSecondClock(running);
  const model = taskListModel({
    rows,
    meta: state.meta,
    now,
    width,
    selected,
    filter,
    cancelling,
  });
  const selectedIndex = Math.max(0, Math.min(selected, model.rows.length - 1));
  const selectedRow = detailJobId ? detailRow : model.rows[selectedIndex];

  // Reaching the last row loads the next page (Web D11).
  const canLoadMore =
    state.meta?.hasMore === true && !state.loadingMore && !state.moreError;
  useEffect(() => {
    if (!detailJobId && canLoadMore && selectedIndex >= model.rows.length - 1)
      void reader.loadMore();
  }, [detailJobId, canLoadMore, selectedIndex, model.rows.length, reader]);

  const release = (jobId: string): void => {
    setCancelling((current) => {
      const next = new Set(current);
      next.delete(jobId);
      return next;
    });
  };
  const cancel = (row: UiShellJobRow): void => {
    setCancelling((current) => new Set(current).add(row.jobId));
    if (!client.stopShellJob) {
      release(row.jobId);
      setNotice("Background tasks are unavailable");
      return;
    }
    const signal = AbortSignal.timeout(STOP_REQUEST_TIMEOUT_MS);
    client
      .stopShellJob({ rootSessionId, jobId: row.jobId, signal })
      .then((result) => {
        if (result.outcome === "already-terminal") release(row.jobId);
        else settle([result.job]);
      })
      .catch((error: unknown) => {
        release(row.jobId);
        const code = errorCode(error);
        // In-process RPC normalizes abort errors, so inspect our signal.
        if (signal.aborted) {
          if (cancellingRef.current.has(row.jobId))
            setNotice("System didn't respond to Cancel. Try again.");
        } else if (code === "SHELL_JOB_CLEANUP_BUSY")
          setNotice("ohbaby is already cleaning up this task.");
        else if (
          code !== "SHELL_JOB_OTHER_BACKEND" &&
          code !== "SHELL_JOB_NOT_FOUND" &&
          code !== "SESSION_SCOPE_CHANGED"
        )
          setNotice(formatError(error));
      })
      .finally(() => {
        void reader.refresh();
      });
  };

  // Fixed rows: title, optional approval line, optional error, key line, and
  // the root's reserve, as the subagent browser budgets them.
  const loadError = detailJobId
    ? output.error
    : (state.error ?? state.moreError);
  const fixedRows =
    1 +
    (approvalPending ? 1 : 0) +
    (notice ? 1 : 0) +
    (loadError ? 1 : 0) +
    1 +
    3;
  const bodyHeight = Math.max(1, layout.rows - fixedRows);
  const header = detailRow
    ? detailHeader({
        row: detailRow,
        now,
        width,
        cancelling: cancelling.has(detailRow.jobId),
      })
    : [];
  const ended = detailRow !== undefined && detailRow.status !== "running";
  const out = outputLines(output.output, ended, width);
  const outputHeight = Math.max(1, bodyHeight - header.length - 1);
  const outputMaxTop = Math.max(0, out.length - outputHeight);
  const top =
    outputTop === null ? outputMaxTop : Math.min(outputTop, outputMaxTop);
  const following = outputTop === null;
  const scrollOutput = (delta: number): void => {
    const next = Math.max(0, Math.min(outputMaxTop, top + delta));
    // Scrolling back to the bottom resumes following (04 §1.1).
    setOutputTop(next >= outputMaxTop ? null : next);
  };
  const tooSmall = width < PANEL_MIN_WIDTH || layout.rows < PANEL_MIN_ROWS;
  const showLoading = useDelayed(state.loading && !state.rows, 300);
  const showMoreLoading = useDelayed(state.loadingMore, 300);

  useInput((value, key) => {
    if (tooSmall) {
      if (key.escape) onClose();
      return;
    }
    // Only cancel failures clear on the next key; load errors stay (04 §1.1).
    if (notice) setNotice(undefined);
    if (confirm) {
      // Any other key only leaves the confirmation (T6).
      const target = confirm;
      setConfirm(null);
      if (!key.ctrl && !key.meta && (value === "y" || value === "Y")) {
        const row =
          rows.find((item) => item.jobId === target.jobId) ?? detailRow;
        if (row && row.jobId === target.jobId && canCancelRow(row)) cancel(row);
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      if (detailJobId) {
        const index = model.rows.findIndex((row) => row.jobId === detailJobId);
        if (index >= 0) setSelected(index);
        setDetailJobId(undefined);
      } else onClose();
      return;
    }
    if (value === "c") {
      if (
        selectedRow &&
        canCancelRow(selectedRow) &&
        !cancelling.has(selectedRow.jobId)
      )
        setConfirm({
          jobId: selectedRow.jobId,
          title: taskTitle(selectedRow),
        });
      return;
    }
    if (value === "r") {
      if (detailJobId) {
        if (output.error) output.retry();
      } else if (state.moreError) void reader.loadMore();
      else if (state.error) void reader.refresh();
      return;
    }
    if (detailJobId) {
      if (key.upArrow) scrollOutput(-1);
      else if (key.downArrow) scrollOutput(1);
      else if (key.pageUp) scrollOutput(-outputHeight);
      else if (key.pageDown) scrollOutput(outputHeight);
      else if (key.end) setOutputTop(null);
      return;
    }
    if (value === "f") {
      if (filterable) {
        setUserFiltered(true);
        setSelected(0);
        changeFilter(
          FILTER_ORDER[
            (FILTER_ORDER.indexOf(filter) + 1) % FILTER_ORDER.length
          ] ?? "main",
        );
      }
      return;
    }
    const last = Math.max(0, model.rows.length - 1);
    if (key.upArrow) setSelected(Math.max(0, selectedIndex - 1));
    else if (key.downArrow) setSelected(Math.min(last, selectedIndex + 1));
    else if (key.pageUp) setSelected(Math.max(0, selectedIndex - bodyHeight));
    else if (key.pageDown)
      setSelected(Math.min(last, selectedIndex + bodyHeight));
    else if (key.end) setSelected(last);
    else if (key.return && model.rows[selectedIndex]) {
      setOutputTop(null);
      setDetailJobId(model.rows[selectedIndex].jobId);
    }
  });

  if (tooSmall)
    return (
      <Box flexDirection="column">
        <Text dimColor>Terminal too small</Text>
      </Box>
    );

  const footer: Line = confirm
    ? confirmLine(confirm.title, width)
    : keyLine({
        view: detailJobId ? "detail" : "list",
        canCancel:
          selectedRow !== undefined &&
          canCancelRow(selectedRow) &&
          !cancelling.has(selectedRow.jobId),
        filterable,
        following,
        retry: loadError !== undefined,
      });
  const errorLine: Line | undefined = loadError
    ? [{ text: `${formatError(loadError)} · r retry`, tone: "error" }]
    : undefined;

  let body: readonly Line[];
  if (detailJobId) {
    if (!detailRow)
      body = output.notFound
        ? [[{ text: "This task is no longer available.", tone: "dim" }]]
        : [];
    else
      body = [
        ...header,
        [{ text: "─".repeat(width), tone: "dim" }],
        ...out.slice(top, top + outputHeight),
      ];
  } else if (!state.rows) {
    body = showLoading ? [[{ text: "Loading…", tone: "dim" }]] : [];
  } else {
    const anchor = model.rowLine[selectedIndex] ?? 0;
    const start = windowStart(anchor, bodyHeight, model.lines.length);
    body = [
      ...model.lines.slice(start, start + bodyHeight),
      ...(showMoreLoading && model.lines.length - start <= bodyHeight
        ? [[{ text: "Loading…", tone: "dim" as const }]]
        : []),
    ];
  }

  return (
    <Box flexDirection="column">
      <LineView line={panelTitle(filter, filterable)} />
      {approvalPending ? (
        <Text dimColor>Approval pending · Close this panel to review</Text>
      ) : null}
      {notice ? <LineView line={[{ text: notice, tone: "error" }]} /> : null}
      {errorLine ? <LineView line={errorLine} /> : null}
      {body.map((line, index) => (
        <LineView key={String(index)} line={line} />
      ))}
      <LineView line={footer} />
    </Box>
  );
}
