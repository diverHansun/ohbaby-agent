import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPhoneViewport } from "./viewport.js";

/** Where a menu opens: below `y`, or above `aboveY` when it would overflow the viewport. */
export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly aboveY: number;
  readonly alignRight: boolean;
}

const VIEWPORT_MARGIN = 8;
const ITEM_SELECTOR = "[role='menuitem']";
const ACTIVE_ITEM_SELECTOR = `${ITEM_SELECTOR}:not(:disabled):not([hidden])`;

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

/** Case-insensitive substring match used by the filter field. */
export function menuItemMatches(label: string, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === "" || label.toLowerCase().includes(wanted);
}

/**
 * A popup menu rendered into `document.body`. On wider screens it is placed at
 * its anchor; below 640px it is a bottom sheet with a backdrop, a title and
 * Cancel (03 §5). It handles arrow-key navigation, Escape, Tab and outside
 * dismissal. Content is plain children: buttons with `role="menuitem"`. A
 * caller that needs a second level swaps the children in place (no nested
 * submenus) and passes a new `level` so focus moves to the first item again.
 *
 * With `filterable`, a text field above the items hides the ones whose text
 * does not contain the query; callers turn it on for lists longer than 8.
 */
export function Menu(props: {
  readonly anchor: MenuAnchor;
  readonly label: string;
  /** Heading of the phone sheet; defaults to `label`. */
  readonly title?: string;
  readonly level?: string;
  readonly className?: string;
  readonly filterable?: boolean;
  /** Item to focus when the menu opens or changes level; defaults to the first item. */
  readonly focusSelector?: string;
  /** The trigger handles its own toggle; its pointerdown is not an outside click. */
  readonly triggerRef?: RefObject<HTMLElement | null>;
  /** Escape goes back one level when provided; otherwise it closes the menu. */
  readonly onEscape?: () => void;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly children: ReactNode;
}): ReactElement {
  const [sheet] = useState(isPhoneViewport);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [query, setQuery] = useState("");
  const [noMatches, setNoMatches] = useState(false);
  const onCloseRef = useRef(props.onClose);
  useLayoutEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useLayoutEffect(() => {
    setQuery("");
  }, [props.level]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (!sheet) {
      const { width, height } = menu.getBoundingClientRect();
      setPosition(
        placeMenu(
          props.anchor,
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }
    // On a phone the filter does not take focus: the keyboard would cover the sheet.
    const target =
      (props.filterable && !sheet ? filterRef.current : null) ??
      (props.focusSelector
        ? menu.querySelector<HTMLElement>(props.focusSelector)
        : null) ??
      menu.querySelector<HTMLElement>(ACTIVE_ITEM_SELECTOR);
    target?.focus({ preventScroll: true });
  }, [props.anchor, props.level, props.focusSelector, props.filterable, sheet]);

  // Filtering hides non-matching items in place, so callers keep plain children.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !props.filterable) return;
    let visible = 0;
    for (const item of menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
      if (item.dataset.menuFilter === "false") continue;
      item.hidden = !menuItemMatches(item.textContent, query);
      if (!item.hidden) visible += 1;
    }
    for (const separator of menu.querySelectorAll<HTMLElement>(
      "[role='separator']",
    ))
      separator.hidden = query.trim() !== "";
    setNoMatches(visible === 0);
  }, [query, props.filterable, props.children]);

  useEffect(() => {
    const close = (): void => {
      onCloseRef.current(false);
    };
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !props.triggerRef?.current?.contains(event.target)
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
    window.addEventListener("scroll", scroll, true);
    // A phone keyboard resizes the viewport; only an anchored menu loses its place.
    if (!sheet) window.addEventListener("resize", close);
    return (): void => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
    };
  }, [sheet, props.triggerRef]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const inFilter = event.target === filterRef.current;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query !== "") setQuery("");
      else if (props.onEscape) props.onEscape();
      else props.onClose(true);
      return;
    }
    if (event.key === "Tab") {
      // Restore the anchor before the native Tab action advances focus.
      props.onClose(true);
      return;
    }
    if (
      !inFilter &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.length === 1
    ) {
      const shortcut = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          ACTIVE_ITEM_SELECTOR,
        ),
      ).find((item) => item.dataset.menuShortcut === event.key.toLowerCase());
      if (shortcut) {
        event.preventDefault();
        event.stopPropagation();
        shortcut.click();
        return;
      }
    }
    if (inFilter && (event.key === "Home" || event.key === "End")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(ACTIVE_ITEM_SELECTOR),
    );
    if (items.length === 0) return;
    const index = inFilter
      ? event.key === "ArrowDown"
        ? -1
        : 0
      : items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    const item = items.at(next);
    if (!item) return;
    item.focus({ preventScroll: true });
    // Bring a row of a scrolling list into view (jsdom has no scrollIntoView).
    if (typeof item.scrollIntoView === "function")
      item.scrollIntoView({ block: "nearest" });
  };

  const body = (
    <>
      {props.filterable ? (
        <input
          ref={filterRef}
          className="ohb-menu-filter"
          type="text"
          aria-label="Filter"
          placeholder="Filter…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      ) : null}
      {props.children}
      {noMatches && props.filterable ? (
        <p className="ohb-menu-empty">No matches</p>
      ) : null}
    </>
  );

  const surface = (
    <div
      ref={menuRef}
      className={`ohb-menu${sheet ? " is-sheet" : ""}${props.className ? ` ${props.className}` : ""}`}
      role={sheet ? "dialog" : "menu"}
      aria-modal={sheet ? true : undefined}
      aria-label={props.label}
      style={sheet ? undefined : position}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      {sheet ? (
        <>
          <div className="ohb-menu-sheet-title">
            {props.title ?? props.label}
          </div>
          <div
            className="ohb-menu-sheet-body"
            role="menu"
            aria-label={props.label}
          >
            {body}
          </div>
          <button
            type="button"
            className="ohb-menu-sheet-cancel"
            onClick={() => {
              props.onClose(true);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        body
      )}
    </div>
  );

  return createPortal(
    sheet ? (
      <div className="ohb-menu-sheet-layer">
        <div className="ohb-menu-sheet-backdrop" aria-hidden="true" />
        {surface}
      </div>
    ) : (
      surface
    ),
    document.body,
  );
}
