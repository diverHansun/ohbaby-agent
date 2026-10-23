import type { ReactElement, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Where a menu opens: below `y`, or above `aboveY` when it would overflow the viewport. */
export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly aboveY: number;
  readonly alignRight: boolean;
}

const VIEWPORT_MARGIN = 8;

/** Keeps a menu of `width`×`height` inside the viewport, flipping above or left when needed. */
export function placeMenu(
  anchor: MenuAnchor,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const left =
    anchor.alignRight ||
    anchor.x + size.width > viewport.width - VIEWPORT_MARGIN
      ? anchor.x - size.width
      : anchor.x;
  const top =
    anchor.y + size.height > viewport.height - VIEWPORT_MARGIN
      ? anchor.aboveY - size.height
      : anchor.y;
  return {
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, viewport.width - size.width - VIEWPORT_MARGIN),
    ),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, viewport.height - size.height - VIEWPORT_MARGIN),
    ),
  };
}

/** Anchor below an element, aligned to its right edge. */
export function anchorBelow(element: HTMLElement): MenuAnchor {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.right,
    y: bounds.bottom + 4,
    aboveY: bounds.top - 4,
    alignRight: true,
  };
}

/**
 * A popup menu rendered into `document.body` with fixed positioning. It handles
 * placement, arrow-key navigation, Escape, Tab and outside dismissal. Content is
 * plain children: buttons with `role="menuitem"`. A caller that needs a second
 * level swaps the children in place (no nested submenus) and passes a new `level`
 * so focus moves to the first item again.
 */
export function Menu(props: {
  readonly anchor: MenuAnchor;
  readonly label: string;
  readonly level?: string;
  readonly className?: string;
  /** Item to focus when the menu opens or changes level; defaults to the first item. */
  readonly focusSelector?: string;
  /** Escape goes back one level when provided; otherwise it closes the menu. */
  readonly onEscape?: () => void;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly children: ReactNode;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const onCloseRef = useRef(props.onClose);
  useLayoutEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition(
      placeMenu(
        props.anchor,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    (
      (props.focusSelector
        ? menu.querySelector<HTMLElement>(props.focusSelector)
        : null) ??
      menu.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")
    )?.focus({ preventScroll: true });
  }, [props.anchor, props.level, props.focusSelector]);

  useEffect(() => {
    const close = (): void => {
      onCloseRef.current(false);
    };
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        close();
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
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className={`ohb-menu${props.className ? ` ${props.className}` : ""}`}
      role="menu"
      aria-label={props.label}
      style={position}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (props.onEscape) props.onEscape();
          else props.onClose(true);
        } else if (event.key === "Tab") {
          // Restore the anchor before the native Tab action advances focus.
          props.onClose(true);
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "[role='menuitem']:not(:disabled)",
            ),
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
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
      {props.children}
    </div>,
    document.body,
  );
}
