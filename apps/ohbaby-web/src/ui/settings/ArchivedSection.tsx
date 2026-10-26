import { Archive, Trash2 } from "lucide-react";
import {
  SESSION_NOT_ARCHIVED_ERROR_CODE,
  type UiGlobalSession,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { readableError } from "../shared/error-text.js";
import { IconButton } from "../shared/IconButton.js";
import { SettingsRow } from "../shared/SettingsRow.js";
import { Spinner } from "../shared/Spinner.js";
import { useDelayed } from "../shared/use-delayed.js";
import { relativeTime } from "../sidebar/relative-time.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";
import { SectionHeader } from "./SectionFrame.js";
import { errorText } from "./useSettingsResource.js";

/** What Settings › Archived needs from the runtime. */
export type ArchivedSessionsApi = Pick<
  OhbabyWebRuntime,
  "listArchivedSessions" | "unarchiveSession" | "deleteSession"
>;

/** Reads answered within this time show no loading line (04 §2.6). */
const LOADING_DELAY_MS = 300;

const ABSOLUTE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface ListState {
  readonly status: "loading" | "ready" | "error";
  readonly rows: readonly UiGlobalSession[];
  readonly nextCursor: string | undefined;
  readonly error: string | null;
  readonly loadingMore: boolean;
  readonly moreError: string | null;
}

interface RowState {
  readonly busy?: boolean;
  readonly error?: string;
}

const INITIAL: ListState = {
  status: "loading",
  rows: [],
  nextCursor: undefined,
  error: null,
  loadingMore: false,
  moreError: null,
};

function titleOf(session: UiGlobalSession): string {
  return session.title.trim() || "Untitled session";
}

/** The row is gone on the server already: restored or deleted elsewhere. */
function alreadyGone(error: unknown): boolean {
  return (
    isDaemonRequestError(error) &&
    (error.status === 404 || error.code === SESSION_NOT_ARCHIVED_ERROR_CODE)
  );
}

/**
 * Settings › Archived (D9): archived chats, most recently archived first,
 * each with Restore and a confirmed permanent Delete. The list is paged
 * here rather than cached, and reread whenever the section is shown.
 */
export function ArchivedSection(props: {
  readonly archive: ArchivedSessionsApi;
  readonly visible: boolean;
}): ReactElement {
  const { archive, visible } = props;
  const [list, setList] = useState<ListState>(INITIAL);
  const [rowStates, setRowStates] = useState<
    Readonly<Partial<Record<string, RowState>>>
  >({});
  const [confirm, setConfirm] = useState<UiGlobalSession | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const sectionRef = useRef<HTMLElement>(null);
  // A later read wins; an earlier one answering late is dropped.
  const reads = useRef(0);
  // Reads started before a successful mutation must be refreshed.
  const mutations = useRef(0);
  // After a row leaves, focus goes to the next row, else the section.
  const focusNext = useRef<string | null | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    const read = ++reads.current;
    const mutation = mutations.current;
    setList((current) => ({ ...current, status: "loading", error: null }));
    try {
      const page = await archive.listArchivedSessions();
      if (read !== reads.current) return;
      if (mutation !== mutations.current) return void load();
      setNow(Date.now());
      setList({
        ...INITIAL,
        status: "ready",
        rows: page.sessions,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (read !== reads.current) return;
      if (mutation !== mutations.current) return void load();
      setList((current) => ({
        ...current,
        status: "error",
        error: readableError(errorText(error)),
      }));
    }
  }, [archive]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const loadMore = async (): Promise<void> => {
    const cursor = list.nextCursor;
    if (cursor === undefined || list.loadingMore) return;
    const read = reads.current;
    const mutation = mutations.current;
    setList((current) => ({ ...current, loadingMore: true, moreError: null }));
    try {
      const page = await archive.listArchivedSessions(cursor);
      if (read !== reads.current) return;
      if (mutation !== mutations.current) return void load();
      setList((current) => {
        const seen = new Set(current.rows.map((row) => row.id));
        return {
          ...current,
          rows: [
            ...current.rows,
            ...page.sessions.filter((row) => !seen.has(row.id)),
          ],
          nextCursor: page.nextCursor,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (read !== reads.current) return;
      if (mutation !== mutations.current) return void load();
      setList((current) => ({
        ...current,
        loadingMore: false,
        moreError: readableError(errorText(error)),
      }));
    }
  };

  const setRow = (id: string, state: RowState | null): void => {
    setRowStates((current) => {
      const { [id]: _previous, ...rest } = current;
      return state === null ? rest : { ...rest, [id]: state };
    });
  };

  const removeRow = (id: string): void => {
    mutations.current += 1;
    const index = list.rows.findIndex((row) => row.id === id);
    const neighbour =
      list.rows.at(index + 1) ??
      (index > 0 ? list.rows.at(index - 1) : undefined);
    focusNext.current = neighbour?.id ?? null;
    setRow(id, null);
    setList((current) => ({
      ...current,
      rows: current.rows.filter((row) => row.id !== id),
    }));
  };

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === undefined) return;
    focusNext.current = undefined;
    if (!visible || confirm !== null) return;
    const section = sectionRef.current;
    const restore =
      target === null
        ? null
        : [
            ...(section?.querySelectorAll<HTMLElement>("[data-session-id]") ??
              []),
          ]
            .find((row) => row.dataset.sessionId === target)
            ?.querySelector<HTMLElement>(".ohb-archived-restore");
    (restore ?? section)?.focus({ preventScroll: true });
  }, [list.rows, visible, confirm]);

  const restore = async (session: UiGlobalSession): Promise<void> => {
    setRow(session.id, { busy: true });
    try {
      await archive.unarchiveSession(session.id);
      setAnnouncement(`Restored “${titleOf(session)}”.`);
      removeRow(session.id);
    } catch (error) {
      if (alreadyGone(error)) removeRow(session.id);
      else
        setRow(session.id, {
          error: `Couldn't restore. ${readableError(errorText(error))}`,
        });
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!confirm || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await archive.deleteSession(confirm.id);
      setAnnouncement(`Deleted “${titleOf(confirm)}”.`);
      setConfirm(null);
      removeRow(confirm.id);
    } catch (error) {
      if (alreadyGone(error)) {
        setConfirm(null);
        removeRow(confirm.id);
      } else setConfirmError(readableError(errorText(error)));
    } finally {
      setConfirmBusy(false);
    }
  };

  const loading = useDelayed(
    list.status === "loading" && list.rows.length === 0,
    LOADING_DELAY_MS,
  );

  return (
    <section
      ref={sectionRef}
      className="ohb-settings-section ohb-archived"
      aria-label="Archived"
      tabIndex={-1}
    >
      <SectionHeader title="Archived" />
      <p className="ohb-settings-lede">
        Archived chats are hidden from the sidebar. Restore one to pick it up
        where you left off, or delete it for good.
      </p>
      {list.status === "error" ? (
        <p className="ohb-settings-status is-error" role="alert">
          <span>
            Couldn&apos;t load archived chats.{" "}
            <span className="ohb-settings-status-detail">{list.error}</span>
          </span>
          <button
            type="button"
            className="ohb-text-button"
            onClick={() => {
              void load();
            }}
          >
            Retry
          </button>
        </p>
      ) : loading ? (
        <p className="ohb-settings-status">Loading…</p>
      ) : list.status === "ready" && list.rows.length === 0 ? (
        <div className="ohb-archived-empty">
          <span className="ohb-archived-empty-icon" aria-hidden="true">
            <Archive size={18} />
          </span>
          <p className="ohb-archived-empty-title">No archived chats</p>
          <p className="ohb-archived-empty-hint">
            Chats you archive from the sidebar show up here.
          </p>
        </div>
      ) : null}
      {list.rows.length > 0 ? (
        <div className="ohb-archived-list" role="list">
          {list.rows.map((session) => {
            const row = rowStates[session.id];
            const title = titleOf(session);
            const age = relativeTime(session.updatedAt, now);
            const archivedAt = Date.parse(session.updatedAt);
            return (
              <div
                key={session.id}
                role="listitem"
                className="ohb-archived-item"
                data-session-id={session.id}
              >
                <SettingsRow
                  muted={!session.title.trim()}
                  label={<span title={title}>{title}</span>}
                  description={
                    <>
                      <span
                        className="ohb-archived-workspace"
                        title={session.workspaceDirectory ?? undefined}
                      >
                        {session.workspaceDirectory
                          ? workspaceLabel(session.workspaceDirectory)
                          : "No workspace"}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <time
                        dateTime={session.updatedAt}
                        title={
                          Number.isNaN(archivedAt)
                            ? undefined
                            : ABSOLUTE_TIME.format(archivedAt)
                        }
                      >
                        Archived {age === "now" ? "just now" : `${age} ago`}
                      </time>
                    </>
                  }
                  control={
                    <>
                      <IconButton
                        label={`Delete “${title}”`}
                        className="ohb-archived-delete"
                        disabled={row?.busy}
                        onClick={() => {
                          setConfirmError(null);
                          setConfirm(session);
                        }}
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </IconButton>
                      <button
                        type="button"
                        className="ohb-archived-restore"
                        aria-label={`Restore “${title}”`}
                        aria-busy={row?.busy}
                        disabled={row?.busy}
                        onClick={() => {
                          void restore(session);
                        }}
                      >
                        {row?.busy ? (
                          <Spinner size={11} label="Restoring" />
                        ) : null}
                        Restore
                      </button>
                    </>
                  }
                />
                {row?.error ? (
                  <p className="ohb-settings-row-error" role="alert">
                    {row.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {list.nextCursor !== undefined ? (
        <div className="ohb-archived-more">
          <button
            type="button"
            className="ohb-text-button"
            aria-busy={list.loadingMore}
            disabled={list.loadingMore}
            onClick={() => {
              void loadMore();
            }}
          >
            {list.loadingMore ? <Spinner size={11} label="Loading" /> : null}
            Show more
          </button>
          {list.moreError ? (
            <p className="ohb-settings-row-error" role="alert">
              Couldn&apos;t load more. {list.moreError}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="ohb-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {confirm ? (
        <ConfirmDialog
          title="Delete this chat permanently?"
          description={`“${titleOf(confirm)}” and its history will be removed. This can’t be undone.`}
          confirmLabel="Delete"
          danger
          busy={confirmBusy}
          error={confirmError}
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={() => {
            void confirmDelete();
          }}
        />
      ) : null}
    </section>
  );
}
