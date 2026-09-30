import { Archive, Pin } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

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
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
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
        } else if (event.key === "Tab") {
          // Restore the anchor before the native Tab action advances focus.
          props.onClose(true);
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
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
      <button role="menuitem" type="button" onClick={props.onPin}>
        <Pin
          aria-hidden="true"
          size={13}
          fill={props.pinned ? "currentColor" : "none"}
        />
        <span>{props.pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button role="menuitem" type="button" onClick={props.onArchive}>
        <Archive aria-hidden="true" size={13} />
        <span>Archive</span>
      </button>
    </div>,
    document.body,
  );
}
