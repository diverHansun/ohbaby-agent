import type { UiGlobalSession } from "ohbaby-sdk";
import {
  AlertCircle,
  ChevronRight,
  FolderPlus,
  PanelLeft,
  SquarePen,
} from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
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
import { IconButton } from "../shared/IconButton.js";
import { Wordmark } from "../shared/Wordmark.js";
import {
  readCollapsedProjects,
  writeCollapsedProjects,
} from "./collapsed-projects.js";
import { GroupFooter } from "./GroupFooter.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { getGlobalSessionPinsStore } from "./session-pins.js";
import type { SessionExportFormat } from "./SessionActionsMenu.js";
import { SessionList } from "./SessionList.js";

/** Lists that answer within this time show no loading line (04 §3). */
const LOADING_DELAY_MS = 300;

export interface SidebarProps {
  readonly serverUrl?: string;
  readonly catalog: GlobalCatalogSnapshot;
  readonly activeSessionId: string | null;
  /** Running and awaiting state; known only for the connected instance (06 §3.4). */
  readonly activity: ReadonlyMap<string, SessionActivity>;
  readonly disabled: boolean;
  readonly onCollapse: () => void;
  /** `null` starts a draft in No project. */
  readonly onNewChat: (projectDirectory: string | null) => void;
  readonly onSelectSession: (session: SidebarSessionItem) => void;
  readonly onArchiveSession: (session: SidebarSessionItem) => Promise<boolean>;
  readonly onExportSession: (
    session: SidebarSessionItem,
    format: SessionExportFormat,
  ) => void;
  readonly onHideProject: (directory: string) => void;
  readonly onOpenFolder: () => void;
  readonly onRetry: () => void;
  readonly onLoadMore: (
    enough: (sessions: readonly UiGlobalSession[]) => boolean,
  ) => Promise<void>;
}

/**
 * Wordmark, New chat and every chat across projects (03 §4.4): Pinned, then
 * projects, then No project. Each group shows 6 rows (Pinned 8) and Show more
 * adds 20, paging the global list when the loaded rows are not enough.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const newRef = useRef<HTMLButtonElement>(null);
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
  const [collapsed, setCollapsed] = useState(readCollapsedProjects);
  const [extra, setExtra] = useState<
    Readonly<Partial<Record<SidebarGroupKey, number>>>
  >({});
  const [loadingKey, setLoadingKey] = useState<SidebarGroupKey | null>(null);
  const now = useMinuteClock();
  const { catalog } = props;
  const groups = useMemo(
    () =>
      selectSidebarGroups({
        projects: catalog.projects,
        sessions: catalog.sessions,
        pins: pins.pins,
        activity: props.activity,
        extra,
        hasMore: catalog.nextCursor !== undefined,
      }),
    [
      catalog.projects,
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
  const activeProject =
    catalog.sessions.find((session) => session.id === props.activeSessionId)
      ?.projectDirectory ?? null;

  const toggle = useCallback((key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedProjects(next);
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
      <SessionList
        sessions={group.visible}
        pins={pinsStore}
        activeSessionId={props.activeSessionId}
        disabled={props.disabled}
        now={now}
        fallbackFocus={() => newRef.current}
        onSelectSession={props.onSelectSession}
        onArchiveSession={props.onArchiveSession}
        onExportSession={props.onExportSession}
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
      </nav>
      <div className="ohb-sidebar-scroll">
        {pins.error ? (
          <p className="ohb-session-pin-error" role="status">
            Pins could not be saved. Changes last until refresh.
          </p>
        ) : null}
        {groups.pinned ? (
          <SidebarSection
            title="Pinned"
            group={groups.pinned}
            expanded={!collapsed.has("pinned")}
            onToggle={() => {
              toggle("pinned");
            }}
          >
            {list(groups.pinned)}
          </SidebarSection>
        ) : null}
        <div className="ohb-sidebar-section-title">
          <span>Projects</span>
          <span className="ohb-sidebar-section-actions">
            {catalog.projectsStatus === "error" ? (
              <IconButton
                label="Projects could not be loaded. Retry"
                onClick={props.onRetry}
              >
                <AlertCircle aria-hidden="true" size={13} />
              </IconButton>
            ) : null}
            <IconButton label="Open folder…" onClick={props.onOpenFolder}>
              <FolderPlus aria-hidden="true" size={13} />
            </IconButton>
          </span>
        </div>
        {groups.projects.map((group) => (
          <ProjectGroup
            key={group.key}
            directory={group.project.directory}
            current={group.project.directory === activeProject}
            available={group.project.available}
            expanded={!collapsed.has(group.key)}
            loadedCount={group.sessions.length}
            onToggle={() => {
              toggle(group.key);
            }}
            {...(group.project.available
              ? {
                  onNewChat: (): void => {
                    props.onNewChat(group.project.directory);
                  },
                }
              : {})}
            onHide={() => {
              props.onHideProject(group.project.directory);
            }}
          >
            {list(group)}
          </ProjectGroup>
        ))}
        {groups.noProject ? (
          <SidebarSection
            title="No project"
            group={groups.noProject}
            expanded={!collapsed.has("no-project")}
            onToggle={() => {
              toggle("no-project");
            }}
          >
            {list(groups.noProject)}
          </SidebarSection>
        ) : null}
        {showLoading ? <p className="ohb-sidebar-status">Loading…</p> : null}
        {catalog.sessionsStatus === "error" && catalog.sessions.length === 0 ? (
          <p className="ohb-sidebar-status" role="alert">
            <span>Chats could not be loaded.</span>
            <button type="button" onClick={props.onRetry}>
              Retry
            </button>
          </p>
        ) : null}
      </div>
    </aside>
  );
}

/** A foldable section heading (Pinned, No project) with its loaded count. */
function SidebarSection(props: {
  readonly title: string;
  readonly group: SidebarGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="ohb-sidebar-section">
      <button
        type="button"
        className="ohb-sidebar-section-title ohb-sidebar-section-toggle"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span>
          <ChevronRight
            aria-hidden="true"
            size={11}
            className={`ohb-project-chevron${props.expanded ? " is-open" : ""}`}
          />
          {props.title}
        </span>
        {props.group.sessions.length > 0 ? (
          <span className="ohb-group-count">{props.group.sessions.length}</span>
        ) : null}
      </button>
      {props.expanded ? props.children : null}
    </section>
  );
}

/** Re-renders once a minute so relative times stay current. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return (): void => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

/** True once `flag` has stayed true for `delay` ms. */
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
