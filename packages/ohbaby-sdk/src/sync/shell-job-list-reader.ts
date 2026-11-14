import type { UiBackendClient } from "../contract/client.js";
import type {
  UiShellJobList,
  UiShellJobOwnerFilter,
  UiShellJobRow,
} from "../contract/shell-job.js";

/** The backend accepts at most this many rows per list request. */
const MAX_PAGE = 100;

export interface UiShellJobListReaderQuery {
  readonly rootSessionId: string;
  /** Absent lists every owner in the session tree. */
  readonly owner?: UiShellJobOwnerFilter;
  /** `background` leaves out foreground jobs (task panels, README D12). */
  readonly mode?: "background";
  /** Rows per "load more"; a refresh re-reads at least this many. */
  readonly pageSize: number;
}

/** Counts and paging of the last complete read; rows are kept apart. */
export type UiShellJobListMeta = Omit<UiShellJobList, "rows">;

export interface UiShellJobListReaderState {
  readonly rows?: readonly UiShellJobRow[];
  readonly meta?: UiShellJobListMeta;
  /** A refresh is in flight; the previous rows stay readable. */
  readonly loading: boolean;
  readonly loadingMore: boolean;
  /** The last refresh failed; rows and meta are from the read before it. */
  readonly error?: string;
  /** The last "load more" failed; it is not retried until asked. */
  readonly moreError?: string;
}

export interface UiShellJobListReader {
  getSnapshot(): UiShellJobListReaderState;
  subscribe(listener: () => void): () => void;
  /**
   * Re-reads every row already loaded, from the top, and replaces them in one
   * step. A refresh asked for while another runs waits for it, then runs once.
   */
  refresh(): Promise<void>;
  /** Appends the next page; does nothing without one or while one is loading. */
  loadMore(): Promise<void>;
  /** Switches the query: the in-flight read is dropped and rows start over. */
  select(query: UiShellJobListReaderQuery): Promise<void>;
  dispose(): void;
}

function meta(list: UiShellJobList): UiShellJobListMeta {
  const { rows: _rows, ...rest } = list;
  return rest;
}

/** Later pages can repeat a row whose sort position moved; the first copy wins. */
function unique(rows: readonly UiShellJobRow[]): UiShellJobRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.jobId)) return false;
    seen.add(row.jobId);
    return true;
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * One owner scope of a session's background tasks, paged in the backend's
 * order. Reads run one at a time so a stream of invalidations (a running task
 * checkpoints about once a second) never cancels its own answers; callers
 * decide when to refresh.
 */
export function createShellJobListReader(
  client: Partial<UiBackendClient>,
  initialQuery: UiShellJobListReaderQuery,
): UiShellJobListReader {
  let query = initialQuery;
  let state: UiShellJobListReaderState = {
    loading: false,
    loadingMore: false,
  };
  let generation = 0;
  let disposed = false;
  let inflight: AbortController | undefined;
  let chain: Promise<void> = Promise.resolve();
  let queuedRefresh: Promise<void> | undefined;
  let queuedMore: Promise<void> | undefined;
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<UiShellJobListReaderState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const list = async (
    selected: UiShellJobListReaderQuery,
    signal: AbortSignal,
    limit: number,
    cursor?: string,
  ): Promise<UiShellJobList> => {
    if (!client.listShellJobs)
      throw new Error("Background tasks are unavailable");
    const page = await client.listShellJobs({
      rootSessionId: selected.rootSessionId,
      ...(selected.owner ? { owner: selected.owner } : {}),
      ...(selected.mode ? { mode: selected.mode } : {}),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      signal,
    });
    if (
      page.rootSessionId !== selected.rootSessionId ||
      page.rows.some((row) => row.rootSessionId !== selected.rootSessionId)
    )
      throw new Error("Background task list belongs to another chat");
    return page;
  };
  /** Runs `read` after the reads before it; a new query leaves it stale. */
  const enqueue = (
    read: (
      selected: UiShellJobListReaderQuery,
      signal: AbortSignal,
      current: () => boolean,
    ) => Promise<void>,
  ): Promise<void> => {
    const ticket = generation;
    const next = chain.then(async () => {
      if (disposed || ticket !== generation) return;
      const controller = new AbortController();
      inflight = controller;
      try {
        await read(
          query,
          controller.signal,
          () =>
            !disposed && ticket === generation && !controller.signal.aborted,
        );
      } finally {
        if (inflight === controller) inflight = undefined;
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (queuedRefresh) return queuedRefresh;
    const run = enqueue(async (selected, signal, current) => {
      queuedRefresh = undefined;
      publish({ loading: true });
      const target = Math.max(state.rows?.length ?? 0, selected.pageSize);
      try {
        const rows: UiShellJobRow[] = [];
        let page: UiShellJobList | undefined;
        do {
          page = await list(
            selected,
            signal,
            Math.min(MAX_PAGE, target - rows.length),
            page?.nextCursor,
          );
          if (!current()) return;
          rows.push(...page.rows);
        } while (rows.length < target && page.hasMore && page.nextCursor);
        publish({
          rows: unique(rows),
          meta: meta(page),
          loading: false,
          error: undefined,
          moreError: page.hasMore ? state.moreError : undefined,
        });
      } catch (error) {
        if (!current() || isAbort(error)) return;
        publish({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    queuedRefresh = run;
    return run;
  };

  const loadMore = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (queuedMore) return queuedMore;
    if (!state.meta?.hasMore || state.loadingMore) return Promise.resolve();
    const run = enqueue(async (selected, signal, current) => {
      queuedMore = undefined;
      const cursor = state.meta?.nextCursor;
      if (!state.meta?.hasMore || cursor === undefined) return;
      publish({ loadingMore: true, moreError: undefined });
      try {
        const page = await list(selected, signal, selected.pageSize, cursor);
        if (!current()) return;
        publish({
          rows: unique([...(state.rows ?? []), ...page.rows]),
          meta: meta(page),
          loadingMore: false,
        });
      } catch (error) {
        if (!current() || isAbort(error)) return;
        publish({
          loadingMore: false,
          moreError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    queuedMore = run;
    return run;
  };

  return {
    getSnapshot: (): UiShellJobListReaderState => state,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    loadMore,
    select(next): Promise<void> {
      if (disposed) return Promise.resolve();
      generation += 1;
      inflight?.abort();
      queuedRefresh = undefined;
      queuedMore = undefined;
      query = next;
      publish({
        rows: undefined,
        meta: undefined,
        loading: false,
        loadingMore: false,
        error: undefined,
        moreError: undefined,
      });
      return refresh();
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      inflight?.abort();
      listeners.clear();
    },
  };
}
