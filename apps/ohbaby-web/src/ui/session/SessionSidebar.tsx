import { SquarePen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import { compactHomePath, workspaceLabel } from "../workspace/ProjectRail.js";
import type { ViewModel } from "./selectors.js";
import {
  getSessionPinsStore,
  sessionPinsKey,
  sortPinnedSessions,
} from "./session-pins.js";
import {
  SessionActionsMenu,
  type SessionMenuAnchor,
} from "./SessionActionsMenu.js";
import { SessionRow } from "./SessionRow.js";
import { useSessionReorder } from "./use-session-reorder.js";

interface SidebarProps {
  readonly open: boolean;
  readonly serverUrl?: string;
  readonly onArchiveSession: (sessionId: string) => Promise<boolean>;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly view: ViewModel;
  readonly workspace: WorkspaceSnapshot;
}
interface SessionMenu {
  readonly sessionId: string;
  readonly anchor: SessionMenuAnchor;
  readonly trigger: HTMLButtonElement;
}

export function SessionSidebar(props: SidebarProps): ReactElement {
  const scopeKey = sessionPinsKey(
    props.serverUrl,
    props.workspace.selectedDirectory ?? "",
  );
  return (
    <ProjectSessionSidebar key={scopeKey} {...props} scopeKey={scopeKey} />
  );
}

function ProjectSessionSidebar(
  props: SidebarProps & { readonly scopeKey: string },
): ReactElement {
  const pinsStore = useMemo(
    () => getSessionPinsStore(props.scopeKey),
    [props.scopeKey],
  );
  const preferences = useSyncExternalStore(
    useCallback(
      (listener: () => void) => pinsStore.subscribe(listener),
      [pinsStore],
    ),
    () => pinsStore.getSnapshot(),
  );
  const sessions = useMemo(
    () => sortPinnedSessions(props.view.sessionIndex, preferences.pins),
    [props.view.sessionIndex, preferences.pins],
  );
  const [menu, setMenu] = useState<SessionMenu | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const archivedFocus = useRef<{
    trigger: HTMLButtonElement;
    next: HTMLButtonElement | null;
    succeeded: boolean;
  } | null>(null);
  const orderedIds = JSON.stringify(sessions.map((session) => session.id));
  const previousOrder = useRef(orderedIds);
  const restoreArchivedFocus = useCallback((): void => {
    const pending = archivedFocus.current;
    if (!pending?.succeeded || pending.trigger.isConnected || !mounted.current)
      return;
    archivedFocus.current = null;
    if (document.activeElement === document.body) {
      (pending.next?.isConnected ? pending.next : newRef.current)?.focus({
        preventScroll: true,
      });
    }
  }, []);
  useLayoutEffect(() => {
    if (previousOrder.current !== orderedIds) setMenu(null);
    previousOrder.current = orderedIds;
    restoreArchivedFocus();
  }, [orderedIds, restoreArchivedFocus]);
  useEffect(() => {
    const cancelFocus = (event: Event): void => {
      const pending = archivedFocus.current;
      if (
        pending &&
        event.target instanceof Node &&
        !pending.trigger.closest(".ohb-session-row")?.contains(event.target)
      )
        archivedFocus.current = null;
    };
    document.addEventListener("focusin", cancelFocus);
    document.addEventListener("pointerdown", cancelFocus);
    return (): void => {
      document.removeEventListener("focusin", cancelFocus);
      document.removeEventListener("pointerdown", cancelFocus);
    };
  }, []);
  const { prepare, reordering } = useSessionReorder(
    listRef,
    JSON.stringify([sessions.map((session) => session.id), preferences.pins]),
  );
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!props.open || props.view.composer.disabled) setMenu(null);
  }, [props.open, props.view.composer.disabled]);
  const closeMenu = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && menu?.trigger.isConnected)
        menu.trigger.focus({ preventScroll: true });
      setMenu(null);
    },
    [menu],
  );
  const menuSession =
    props.open && !props.view.composer.disabled
      ? sessions.find((session) => session.id === menu?.sessionId)
      : undefined;
  const isPinned = (id: string): boolean => Object.hasOwn(preferences.pins, id);
  const setPin = (
    id: string,
    pinned: boolean,
    focus: HTMLElement | null,
  ): void => {
    prepare(focus);
    setMenu(null);
    pinsStore.setPinned(id, pinned);
  };
  const archive = (id: string): void => {
    const row = menu?.trigger.closest(".ohb-session-row");
    const next =
      row?.nextElementSibling?.querySelector<HTMLButtonElement>(
        ".ohb-session-main",
      );
    const trigger = menu?.trigger;
    closeMenu(true);
    const pending = trigger
      ? { trigger, next: next ?? null, succeeded: false }
      : null;
    archivedFocus.current = pending;
    void props.onArchiveSession(id).then((success) => {
      if (!success) {
        if (archivedFocus.current === pending) archivedFocus.current = null;
        return;
      }
      pinsStore.setPinned(id, false);
      if (pending) pending.succeeded = true;
      restoreArchivedFocus();
    });
  };

  return (
    <aside
      aria-hidden={!props.open}
      className={`ohb-sidebar${props.open ? "" : " is-collapsed"}`}
      inert={!props.open}
    >
      <header className="ohb-sidebar-header">
        <div className="ohb-project-header">
          <strong>
            {workspaceLabel(props.workspace.selectedDirectory ?? "")}
          </strong>
          <small title={props.workspace.selectedDirectory ?? ""}>
            {compactHomePath(props.workspace.selectedDirectory ?? "")}
          </small>
        </div>
      </header>
      <button
        ref={newRef}
        className="ohb-sidebar-new"
        disabled={props.view.composer.disabled}
        onClick={props.onCreateSession}
        title="New session"
        type="button"
      >
        <SquarePen aria-hidden="true" size={15} />
        <span>New session</span>
      </button>
      <section className="ohb-sidebar-section">
        <div className="ohb-sidebar-section-title">Sessions</div>
        {preferences.error ? (
          <p className="ohb-session-pin-error" role="status">
            Pins could not be saved. Changes last until refresh.
          </p>
        ) : null}
        <div ref={listRef} className="ohb-sidebar-list">
          {sessions.length ? (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === props.view.activeSession?.id}
                disabled={props.view.composer.disabled}
                pinned={isPinned(session.id)}
                menuOpen={menuSession?.id === session.id}
                reordering={reordering || !props.open}
                onSelect={() => {
                  if (session.id !== props.view.activeSession?.id)
                    props.onSelectSession(session.id);
                }}
                onUnpin={(focus) => {
                  setPin(session.id, false, focus);
                }}
                onMenu={(anchor, trigger) => {
                  setMenu({ sessionId: session.id, anchor, trigger });
                }}
              />
            ))
          ) : (
            <div className="ohb-sidebar-empty">No sessions yet</div>
          )}
        </div>
      </section>
      {menu && menuSession ? (
        <SessionActionsMenu
          anchor={menu.anchor}
          pinned={isPinned(menuSession.id)}
          title={menuSession.title}
          onClose={closeMenu}
          onPin={() => {
            setPin(menuSession.id, !isPinned(menuSession.id), menu.trigger);
          }}
          onArchive={() => {
            archive(menuSession.id);
          }}
        />
      ) : null}
    </aside>
  );
}
