import {
  globalSessionRequestDirectory,
  type UiGlobalSession,
  type UiSessionSearchPage,
} from "ohbaby-sdk";
import {
  AlertCircle,
  ChevronRight,
  FolderPlus,
  PanelLeft,
  SquarePen,
  Search,
  Settings,
} from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GlobalCatalogSnapshot } from "../../store/global-catalog.js";
import {
  baseCount,
  countGroupRows,
  selectSidebarGroups,
  SHOW_MORE_STEP,
  type SessionActivity,
  type SidebarGroup,
  type SidebarGroupKey,
  type SidebarSessionItem,
} from "../../store/sidebar-groups.js";
import { SidebarSearch } from "../search/SidebarSearch.js";
import { IconButton } from "../shared/IconButton.js";
import { useDelayed } from "../shared/use-delayed.js";
import { useMinuteClock } from "../shared/use-minute-clock.js";
import { Wordmark } from "../shared/Wordmark.js";
import {
  readCollapsedGroups,
  writeCollapsedGroups,
} from "./collapsed-groups.js";
import { GroupFooter } from "./GroupFooter.js";
import { WorkspaceGroup } from "./WorkspaceGroup.js";
import { getGlobalSessionPinsStore } from "./session-pins.js";
import type { SessionExportFormat } from "./SessionMenu.js";
import { SessionList } from "./SessionList.js";

/** Lists that answer within this time show no loading line (04 §3). */
const LOADING_DELAY_MS = 300;

export interface SidebarProps {
  readonly serverUrl?: string;
  readonly searchOpen: boolean;
  readonly searchFocusRequest?: number;
  readonly onSearchOpenChange: (open: boolean) => void;
  readonly searchSessions: (input: {
    query: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<UiSessionSearchPage>;
  readonly catalog: GlobalCatalogSnapshot;
  readonly activeSessionId: string | null;
  /** Running and awaiting state; known only for the connected instance (06 §3.4). */
  readonly activity: ReadonlyMap<string, SessionActivity>;
  readonly disabled: boolean;
  readonly onCollapse: () => void;
  /** `null` starts a draft in No workspace. */
  readonly onNewChat: (workspaceDirectory: string | null) => void;
  readonly onSelectSession: (session: SidebarSessionItem) => void;
  readonly onArchiveSession: (session: SidebarSessionItem) => Promise<boolean>;
  readonly onForkSession: (session: SidebarSessionItem) => void;
  readonly onExportSession: (
    session: SidebarSessionItem,
    format: SessionExportFormat,
  ) => void;
  readonly onMoveSession: (
    session: SidebarSessionItem,
    directory: string | null,
  ) => Promise<boolean>;
  readonly onHideWorkspace: (directory: string) => void;
  readonly onOpenFolder: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: (trigger: HTMLElement) => void;
  readonly onLoadMore: (
    enough: (sessions: readonly UiGlobalSession[]) => boolean,
  ) => Promise<void>;
}

/** Folds every workspace at once; each workspace keeps its own key. */
const WORKSPACES_KEY = "workspaces";

/**
 * Wordmark, New chat and every chat across workspaces (03 §4.4): Pinned, then
 * workspaces, then Recents; Settings sits at the bottom. Each group shows 6 rows (Pinned 8) and Show more
 * adds 20, paging the global list when the loaded rows are not enough.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const newRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const movedFocus = useRef<string | null>(null);
  const closeSearch = (): void => {
    props.onSearchOpenChange(false);
    searchRef.current?.focus({ preventScroll: true });
  };
  const pinsStore = useMemo(
    () => getGlobalSessionPinsStore(props.serverUrl),
    [props.serverUrl],
  );
  const pins = useSyncExternalStore(
    useCallback(
      (listener: () => void) => pinsStore.subscribe(listener),
      [pinsStore],
    ),
    () => pinsStore.getSnapshot(),
  );
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const [extra, setExtra] = useState<
    Readonly<Partial<Record<SidebarGroupKey, number>>>
  >({});
  const [loadingKey, setLoadingKey] = useState<SidebarGroupKey | null>(null);
  const [moving, setMoving] = useState<ReadonlySet<string>>(new Set());
  const now = useMinuteClock();
  const { catalog } = props;
  useLayoutEffect(() => {
    if (movedFocus.current === null) return;
    const id = movedFocus.current;
    movedFocus.current = null;
    if (document.activeElement === document.body) {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-session-id]"),
      ).find((element) => element.dataset.sessionId === id);
      (
        row?.querySelector<HTMLElement>(".ohb-session-actions") ??
        newRef.current
      )?.focus({ preventScroll: true });
    }
  }, [moving, catalog.sessions]);
  const groups = useMemo(
    () =>
      selectSidebarGroups({
        workspaces: catalog.workspaces,
        sessions: catalog.sessions,
        pins: pins.pins,
        activity: props.activity,
        extra,
        hasMore: catalog.nextCursor !== undefined,
      }),
    [
      catalog.workspaces,
      catalog.sessions,
      catalog.nextCursor,
      pins.pins,
      props.activity,
      extra,
    ],
  );
  const showLoading = useDelayed(
    catalog.sessions.length === 0 && catalog.sessionsStatus === "loading",
    LOADING_DELAY_MS,
  );
  const activeWorkspace =
    catalog.sessions.find((session) => session.id === props.activeSessionId)
      ?.workspaceDirectory ?? null;

  const toggle = useCallback((key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedGroups(next);
      return next;
    });
  }, []);
  const showMore = (key: SidebarGroupKey): void => {
    const added = (extra[key] ?? 0) + SHOW_MORE_STEP;
    setExtra((current) => ({ ...current, [key]: added }));
    const target = baseCount(key) + added;
    const pinned = pins.pins;
    if (
      catalog.nextCursor === undefined ||
      countGroupRows(key, catalog.sessions, pinned) >= target
    )
      return;
    setLoadingKey(key);
    void props
      .onLoadMore((rows) => countGroupRows(key, rows, pinned) >= target)
      .finally(() => {
        setLoadingKey((current) => (current === key ? null : current));
      });
  };
  const showLess = (key: SidebarGroupKey): void => {
    setExtra((current) => ({ ...current, [key]: 0 }));
  };
  const list = (group: SidebarGroup): ReactNode => (
    <>
      {group.sessions.length === 0 && !group.canShowMore ? (
        // Like Codex: an empty workspace still says so instead of collapsing to a bare heading.
        <p className="ohb-sidebar-empty">No chats</p>
      ) : null}
      <SessionList
        sessions={group.visible}
        pins={pinsStore}
        workspaces={catalog.workspaces}
        moving={moving}
        onMoveSession={(session, directory) => {
          setMoving((current) => new Set(current).add(session.id));
          void props
            .onMoveSession(session, directory)
            .then(() => {
              movedFocus.current = session.id;
            })
            .finally(() => {
              setMoving((current) => {
                const next = new Set(current);
                next.delete(session.id);
                return next;
              });
            });
        }}
        activeSessionId={props.activeSessionId}
        disabled={props.disabled}
        now={now}
        fallbackFocus={() => newRef.current}
        onSelectSession={props.onSelectSession}
        onArchiveSession={props.onArchiveSession}
        onExportSession={props.onExportSession}
        onForkSession={props.onForkSession}
      />
      <GroupFooter
        group={group}
        loading={loadingKey === group.key}
        onMore={() => {
          showMore(group.key);
        }}
        onLess={() => {
          showLess(group.key);
        }}
      />
    </>
  );

  return (
    <aside className="ohb-sidebar" aria-label="Chats">
      <div className="ohb-sidebar-top">
        <Wordmark size="sm" />
        <IconButton label="Collapse sidebar" onClick={props.onCollapse}>
          <PanelLeft aria-hidden="true" size={15} />
        </IconButton>
      </div>
      <nav className="ohb-sidebar-nav">
        <button
          ref={newRef}
          type="button"
          className="ohb-sidebar-nav-item ohb-sidebar-new"
          onClick={() => {
            props.onNewChat(null);
          }}
        >
          <SquarePen aria-hidden="true" size={15} />
          <span>New chat</span>
        </button>
        <button
          ref={searchRef}
          type="button"
          className="ohb-sidebar-nav-item"
          aria-expanded={props.searchOpen}
          aria-label="Search chats"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => {
            if (props.searchOpen) closeSearch();
            else props.onSearchOpenChange(true);
          }}
        >
          <Search aria-hidden="true" size={15} />
          <span>Search</span>
        </button>
      </nav>
      <div className="ohb-sidebar-scroll">
        <SidebarSearch
          open={props.searchOpen}
          focusRequest={props.searchFocusRequest}
          search={props.searchSessions}
          activeSessionId={props.activeSessionId}
          onClose={closeSearch}
          onSelect={(session) => {
            closeSearch();
            props.onSelectSession({
              ...session,
              requestDirectory: globalSessionRequestDirectory(session),
              pinned: session.id in pins.pins,
              activity: props.activity.get(session.id) ?? "idle",
            });
          }}
        >
          {pins.error ? (
            <p className="ohb-session-pin-error" role="status">
              Pins could not be saved. Changes last until refresh.
            </p>
          ) : null}
          {groups.pinned ? (
            <SidebarSection
              title="Pinned"
              className="ohb-sidebar-pinned"
              expanded={!collapsed.has("pinned")}
              onToggle={() => {
                toggle("pinned");
              }}
            >
              {list(groups.pinned)}
            </SidebarSection>
          ) : null}
          <SidebarSection
            title="Workspaces"
            expanded={!collapsed.has(WORKSPACES_KEY)}
            onToggle={() => {
              toggle(WORKSPACES_KEY);
            }}
            actions={
              <>
                {catalog.workspacesStatus === "error" ? (
                  <IconButton
                    label="Workspaces could not be loaded. Retry"
                    onClick={props.onRetry}
                  >
                    <AlertCircle aria-hidden="true" size={13} />
                  </IconButton>
                ) : null}
                <IconButton label="Open folder…" onClick={props.onOpenFolder}>
                  <FolderPlus aria-hidden="true" size={13} />
                </IconButton>
              </>
            }
          >
            {groups.workspaces.map((group) => (
              <WorkspaceGroup
                key={group.key}
                directory={group.workspace.directory}
                current={group.workspace.directory === activeWorkspace}
                available={group.workspace.available}
                expanded={!collapsed.has(group.key)}
                onToggle={() => {
                  toggle(group.key);
                }}
                {...(group.workspace.available
                  ? {
                      onNewChat: (): void => {
                        props.onNewChat(group.workspace.directory);
                      },
                    }
                  : {})}
                onHide={() => {
                  props.onHideWorkspace(group.workspace.directory);
                }}
              >
                {list(group)}
              </WorkspaceGroup>
            ))}
          </SidebarSection>
          {groups.recents ? (
            <SidebarSection
              title="Recents"
              className="ohb-sidebar-recents"
              expanded={!collapsed.has("recents")}
              onToggle={() => {
                toggle("recents");
              }}
            >
              {list(groups.recents)}
            </SidebarSection>
          ) : null}
          {showLoading ? <p className="ohb-sidebar-status">Loading…</p> : null}
          {catalog.sessionsStatus === "error" &&
          catalog.sessions.length === 0 ? (
            <p className="ohb-sidebar-status" role="alert">
              <span>Chats could not be loaded.</span>
              <button type="button" onClick={props.onRetry}>
                Retry
              </button>
            </p>
          ) : null}
        </SidebarSearch>
      </div>
      <div className="ohb-sidebar-footer">
        <button
          type="button"
          className="ohb-sidebar-nav-item ohb-sidebar-settings"
          aria-haspopup="dialog"
          onClick={(event) => {
            props.onOpenSettings(event.currentTarget);
          }}
        >
          <Settings aria-hidden="true" size={15} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * A foldable section: Pinned, Workspaces and Recents share this heading so
 * their size, colour and left edge match. The chevron follows the title.
 */
function SidebarSection(props: {
  readonly title: string;
  readonly className?: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Buttons at the right end of the heading, outside the toggle. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      className={`ohb-sidebar-section${props.className ? ` ${props.className}` : ""}`}
      aria-label={props.title}
    >
      <div className="ohb-sidebar-section-title">
        <button
          type="button"
          className="ohb-sidebar-section-toggle"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <span>{props.title}</span>
          <ChevronRight
            aria-hidden="true"
            size={12}
            className={`ohb-workspace-chevron${props.expanded ? " is-open" : ""}`}
          />
        </button>
        {props.actions ? (
          <span className="ohb-sidebar-section-actions">{props.actions}</span>
        ) : null}
      </div>
      {props.expanded ? props.children : null}
    </section>
  );
}
