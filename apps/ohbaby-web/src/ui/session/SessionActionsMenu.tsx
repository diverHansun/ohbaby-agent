import { Archive, ChevronRight, Download, Pin } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

export type SessionExportFormat = "html" | "jsonl";

export interface SessionMenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly aboveY: number;
  readonly alignRight: boolean;
}

export function SessionActionsMenu(props: {
  readonly anchor: SessionMenuAnchor;
  readonly pinned: boolean;
  readonly title: string;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onPin: () => void;
  readonly onArchive: () => void;
  readonly onExport: (format: SessionExportFormat) => void;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [submenu, setSubmenu] = useState<{
    readonly focusFirst: boolean;
  } | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 0, top: 0 });
  const cancelHoverClose = useCallback((): void => {
    window.clearTimeout(hoverCloseTimer.current);
  }, []);
  const openSubmenu = useCallback(
    (focusFirst: boolean): void => {
      cancelHoverClose();
      setSubmenu({ focusFirst });
    },
    [cancelHoverClose],
  );
  const closeSubmenu = useCallback(
    (restoreFocus: boolean): void => {
      cancelHoverClose();
      setSubmenu(null);
      if (restoreFocus) exportRef.current?.focus({ preventScroll: true });
    },
    [cancelHoverClose],
  );
  useEffect(() => cancelHoverClose, [cancelHoverClose]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const { x, y, aboveY, alignRight } = props.anchor;
    const left =
      alignRight || x + width > window.innerWidth - 8 ? x - width : x;
    const top = y + height > window.innerHeight - 8 ? aboveY - height : y;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    });
    menu
      .querySelector<HTMLButtonElement>("button")
      ?.focus({ preventScroll: true });
  }, [props.anchor]);
  useLayoutEffect(() => {
    const trigger = exportRef.current;
    const menu = menuRef.current;
    const panel = submenuRef.current;
    if (!submenu || !trigger || !menu || !panel) return;
    // Fixed positioning keeps the panel inside the menu DOM without being clipped by its scroll box.
    const { width, height } = panel.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const right = menuRect.right + 2;
    const left =
      right + width > window.innerWidth - 8 ? menuRect.left - width - 2 : right;
    setSubmenuPosition({
      left: Math.max(8, left),
      top: Math.max(
        8,
        Math.min(triggerRect.top - 5, window.innerHeight - height - 8),
      ),
    });
    if (submenu.focusFirst)
      panel
        .querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
  }, [submenu]);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        props.onClose(false);
    };
    const close = (): void => {
      props.onClose(false);
    };
    const scroll = (event: Event): void => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      )
        return;
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return (): void => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [props.onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="ohb-session-menu"
      role="menu"
      aria-label={`Actions for ${props.title}`}
      style={position}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose(true);
        } else if (
          event.key === "ArrowRight" &&
          document.activeElement === exportRef.current
        ) {
          event.preventDefault();
          openSubmenu(true);
        } else if (event.key === "Tab") {
          // Restore the anchor before the native Tab action advances focus.
          props.onClose(true);
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button[data-menu-level='main']",
            ),
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          items[next]?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        data-menu-level="main"
        role="menuitem"
        type="button"
        onClick={props.onPin}
      >
        <Pin
          aria-hidden="true"
          size={13}
          fill={props.pinned ? "currentColor" : "none"}
        />
        <span>{props.pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button
        data-menu-level="main"
        role="menuitem"
        type="button"
        onClick={props.onArchive}
      >
        <Archive aria-hidden="true" size={13} />
        <span>Archive</span>
      </button>
      <div
        className="ohb-session-submenu-group"
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") openSubmenu(false);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse") return;
          // A short grace period lets the pointer cross the gap into the panel.
          cancelHoverClose();
          hoverCloseTimer.current = window.setTimeout(() => {
            setSubmenu(null);
          }, 150);
        }}
      >
        <button
          ref={exportRef}
          aria-expanded={submenu !== null}
          aria-haspopup="menu"
          data-menu-level="main"
          role="menuitem"
          type="button"
          onClick={(event) => {
            // detail === 0 means keyboard activation (Enter/Space).
            openSubmenu(event.detail === 0);
          }}
        >
          <Download aria-hidden="true" size={13} />
          <span>Export</span>
          <ChevronRight
            aria-hidden="true"
            className="ohb-session-submenu-arrow"
            size={13}
          />
        </button>
        {submenu ? (
          <div
            ref={submenuRef}
            className="ohb-session-menu ohb-session-submenu"
            role="menu"
            aria-label="Export format"
            style={submenuPosition}
            onKeyDown={(event) => {
              // Handled keys must not reach the main menu, or Esc would close everything.
              if (event.key === "Escape" || event.key === "ArrowLeft") {
                event.preventDefault();
                event.stopPropagation();
                closeSubmenu(true);
              } else if (event.key === "Tab") {
                event.stopPropagation();
                props.onClose(true);
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                event.stopPropagation();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  ),
                );
                const index = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
                items[next]?.focus({ preventScroll: true });
              }
            }}
          >
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                props.onExport("html");
              }}
            >
              <span>HTML</span>
            </button>
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                props.onExport("jsonl");
              }}
            >
              <span>JSONL</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
