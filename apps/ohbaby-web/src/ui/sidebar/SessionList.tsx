import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { SidebarSessionItem } from "../../store/sidebar-groups.js";
import type { getSessionPinsStore } from "./session-pins.js";
import {
  SessionActionsMenu,
  type SessionExportFormat,
  type SessionMenuAnchor,
} from "./SessionActionsMenu.js";
import { SessionRow } from "./SessionRow.js";
import { useSessionReorder } from "./use-session-reorder.js";

export interface SessionListProps {
  /** The group's visible rows, already ordered. */
  readonly sessions: readonly SidebarSessionItem[];
  readonly pins: ReturnType<typeof getSessionPinsStore>;
  readonly activeSessionId: string | null;
  readonly disabled: boolean;
  readonly now: number;
  readonly onArchiveSession: (session: SidebarSessionItem) => Promise<boolean>;
  readonly onExportSession: (
    session: SidebarSessionItem,
    format: SessionExportFormat,
  ) => void;
  readonly onSelectSession: (session: SidebarSessionItem) => void;
  /** Where focus goes when an archived row leaves no next row behind. */
  readonly fallbackFocus: () => HTMLElement | null;
}

interface SessionMenu {
  readonly sessionId: string;
  readonly anchor: SessionMenuAnchor;
  readonly trigger: HTMLButtonElement;
}

/**
 * The rows of one sidebar group with the row menu, pins and focus repair
 * after archiving: focus moves to the next row once the archived row leaves.
 */
export function SessionList(props: SessionListProps): ReactElement {
  const { sessions, pins } = props;
  const [menu, setMenu] = useState<SessionMenu | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
      (pending.next?.isConnected ? pending.next : props.fallbackFocus())?.focus(
        { preventScroll: true },
      );
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
  const { prepare, reordering } = useSessionReorder(listRef, orderedIds);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (props.disabled) setMenu(null);
  }, [props.disabled]);
  const closeMenu = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && menu?.trigger.isConnected)
        menu.trigger.focus({ preventScroll: true });
      setMenu(null);
    },
    [menu],
  );
  const menuSession = !props.disabled
    ? sessions.find((session) => session.id === menu?.sessionId)
    : undefined;
  const setPin = (
    session: SidebarSessionItem,
    pinned: boolean,
    focus: HTMLElement | null,
  ): void => {
    prepare(focus);
    setMenu(null);
    pins.setPinned(session.id, pinned);
  };
  const archive = (
    session: SidebarSessionItem,
    trigger: HTMLButtonElement | undefined,
  ): void => {
    const row = trigger?.closest(".ohb-session-row");
    const next =
      row?.nextElementSibling?.querySelector<HTMLButtonElement>(
        ".ohb-session-main",
      );
    if (menu) closeMenu(true);
    const pending = trigger
      ? { trigger, next: next ?? null, succeeded: false }
      : null;
    archivedFocus.current = pending;
    void props.onArchiveSession(session).then((success) => {
      if (!success) {
        if (archivedFocus.current === pending) archivedFocus.current = null;
        return;
      }
      pins.setPinned(session.id, false);
      if (pending) pending.succeeded = true;
      restoreArchivedFocus();
    });
  };

  return (
    <>
      <div ref={listRef} className="ohb-sidebar-list">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            now={props.now}
            active={session.id === props.activeSessionId}
            disabled={props.disabled}
            pinned={session.pinned}
            menuOpen={menuSession?.id === session.id}
            reordering={reordering}
            onSelect={() => {
              if (session.id !== props.activeSessionId)
                props.onSelectSession(session);
            }}
            onArchive={(trigger) => {
              archive(session, trigger);
            }}
            onUnpin={(focus) => {
              setPin(session, false, focus);
            }}
            onMenu={(anchor, trigger) => {
              setMenu({ sessionId: session.id, anchor, trigger });
            }}
          />
        ))}
      </div>
      {menu && menuSession ? (
        <SessionActionsMenu
          anchor={menu.anchor}
          pinned={menuSession.pinned}
          title={menuSession.title}
          onClose={closeMenu}
          onPin={() => {
            setPin(menuSession, !menuSession.pinned, menu.trigger);
          }}
          onArchive={() => {
            archive(menuSession, menu.trigger);
          }}
          onExport={(format) => {
            closeMenu(true);
            props.onExportSession(menuSession, format);
          }}
        />
      ) : null}
    </>
  );
}
