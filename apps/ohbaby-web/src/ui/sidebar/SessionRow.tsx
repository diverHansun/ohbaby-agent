import { MoreHorizontal, Pin } from "lucide-react";
import { normalizeSessionTitle, SESSION_TITLE_MAX_LENGTH } from "ohbaby-sdk";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { SidebarSessionItem } from "../../store/sidebar-groups.js";
import { isImeComposing } from "../composer/ime.js";
import { ActivityMark } from "../conversation/ActivityMark.js";
import { Spinner } from "../shared/Spinner.js";
import type { SessionMenuAnchor } from "./SessionMenu.js";

/**
 * One sidebar session (05 SessionRow): the open button with a status column
 * left of the title (a dot matrix while running, a yellow-orange dot while
 * awaiting approval, a blue dot for a reply not yet seen). The row end holds
 * room for the menu button that shows on hover; a pinned row also shows a
 * filled pin there, which unpins it.
 * While renaming, the title is an input in place and the row-end buttons
 * and row menu shortcuts step aside.
 * Sessions keep their recency order but show no time; messages carry it.
 */
export function SessionRow(props: {
  readonly session: SidebarSessionItem;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly pinned: boolean;
  readonly menuOpen: boolean;
  readonly moving: boolean;
  readonly reordering: boolean;
  readonly editing: boolean;
  readonly onSelect: () => void;
  /** Double-click on the title; the menu's Rename goes through the list. */
  readonly onRenameStart: () => void;
  /** `title` is the raw input; `null` cancels. */
  readonly onRenameEnd: (title: string | null) => void;
  readonly onUnpin: (focusTarget: HTMLElement | null) => void;
  readonly onMenu: (
    anchor: SessionMenuAnchor,
    trigger: HTMLButtonElement,
  ) => void;
}): ReactElement {
  const title = props.session.title.trim() || "Untitled session";
  const mainRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  // Enter and Escape hand focus back to the row; a click elsewhere keeps it there.
  const refocus = useRef(false);
  useEffect(() => {
    if (props.editing || !refocus.current) return;
    refocus.current = false;
    mainRef.current?.focus({ preventScroll: true });
  }, [props.editing]);
  useEffect(() => {
    const titleElement = titleRef.current;
    const text = textRef.current;
    if (
      !titleElement ||
      !text ||
      !hovered ||
      props.menuOpen ||
      props.reordering ||
      props.disabled ||
      props.editing
    )
      return;
    const reduced =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;
    let animation: Animation | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const reset = (): void => {
      clearTimeout(timeout);
      animation?.cancel();
      titleElement.classList.remove("is-scrolling", "is-scroll-ended");
    };
    const schedule = (): void => {
      reset();
      if (reduced?.matches) return;
      timeout = setTimeout(() => {
        if (!rowRef.current?.matches(":hover")) return;
        const distance =
          text.getBoundingClientRect().width - titleElement.clientWidth;
        if (distance <= 1 || typeof text.animate !== "function") return;
        titleElement.classList.add("is-scrolling");
        animation = text.animate(
          [
            { transform: "translateX(0)" },
            { transform: `translateX(-${String(distance)}px)` },
          ],
          {
            duration: (distance / 24) * 1000,
            fill: "forwards",
            easing: "linear",
          },
        );
        animation.onfinish = (): void => {
          titleElement.classList.add("is-scroll-ended");
        };
      }, 600);
    };
    schedule();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(titleElement);
    reduced?.addEventListener("change", schedule);
    return (): void => {
      reset();
      observer?.disconnect();
      reduced?.removeEventListener("change", schedule);
    };
  }, [
    hovered,
    props.menuOpen,
    props.reordering,
    props.disabled,
    props.editing,
    title,
  ]);

  const openAtButton = (): void => {
    const trigger = actionsRef.current;
    if (!trigger || props.disabled || props.moving) return;
    const rect = trigger.getBoundingClientRect();
    props.onMenu(
      {
        x: rect.right,
        y: rect.bottom + 4,
        aboveY: rect.top - 4,
        alignRight: true,
      },
      trigger,
    );
  };
  const lead = props.moving ? (
    <span className="ohb-session-lead">
      <Spinner size={11} label="Moving chat" />
    </span>
  ) : props.session.activity === "running" ? (
    <span className="ohb-session-lead" role="status" aria-label="Running">
      <ActivityMark motion="running" />
    </span>
  ) : props.session.activity === "awaiting" ? (
    <span
      className="ohb-session-lead"
      role="status"
      aria-label="Waiting for approval"
    >
      <span className="ohb-session-awaiting" aria-hidden="true" />
    </span>
  ) : props.session.activity === "unread" ? (
    <span className="ohb-session-lead" role="status" aria-label="New reply">
      <span className="ohb-session-unread" aria-hidden="true" />
    </span>
  ) : null;
  return (
    <div
      ref={rowRef}
      data-session-id={props.session.id}
      className={`ohb-session-row${props.active ? " ohb-session-active" : ""}${props.menuOpen ? " is-menu-open" : ""}${props.pinned ? " is-pinned" : ""}${props.editing ? " is-editing" : ""}`}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      onContextMenu={(event) => {
        if (
          props.editing ||
          props.disabled ||
          props.moving ||
          !actionsRef.current
        )
          return;
        event.preventDefault();
        props.onMenu(
          {
            x: event.clientX,
            y: event.clientY,
            aboveY: event.clientY,
            alignRight: false,
          },
          actionsRef.current,
        );
      }}
      onKeyDown={(event) => {
        if (props.editing) return;
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          openAtButton();
        }
      }}
    >
      {props.editing ? (
        <div className="ohb-session-main">
          {lead}
          <span className="ohb-session-copy">
            <SessionRenameInput
              initial={props.session.title}
              onDone={(value, viaKey) => {
                refocus.current = viaKey;
                props.onRenameEnd(value);
              }}
            />
          </span>
        </div>
      ) : (
        <>
          <button
            ref={mainRef}
            className="ohb-session-main"
            disabled={props.disabled || props.moving}
            aria-current={props.active ? "page" : undefined}
            aria-label={`Select ${title}`}
            onClick={props.onSelect}
            onDoubleClick={() => {
              if (!props.disabled && !props.moving) props.onRenameStart();
            }}
            type="button"
          >
            {lead}
            <span className="ohb-session-copy">
              <strong ref={titleRef} className="ohb-session-title">
                <span ref={textRef}>{title}</span>
              </strong>
              <span className="ohb-session-meta" aria-hidden="true" />
            </span>
          </button>
          <span className="ohb-session-hover-actions">
            {props.pinned ? (
              <button
                className="ohb-session-pin"
                type="button"
                aria-label={`Unpin ${title}`}
                title="Unpin"
                disabled={props.disabled || props.moving}
                onClick={() => {
                  props.onUnpin(mainRef.current);
                }}
              >
                <Pin
                  aria-hidden="true"
                  className="ohb-pin-icon"
                  size={13}
                  fill="currentColor"
                />
              </button>
            ) : null}
            <button
              ref={actionsRef}
              className="ohb-session-actions"
              aria-label={`Actions for ${title}`}
              aria-haspopup="menu"
              aria-expanded={props.menuOpen}
              disabled={props.disabled || props.moving}
              onClick={openAtButton}
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={16} />
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The title as an input (F3–F4b). Enter saves and Escape cancels, unless an
 * input method is composing. Leaving saves only when the user went somewhere
 * else: a list reorder that drops focus gets it back, and another window
 * leaves the edit open.
 */
function SessionRenameInput(props: {
  readonly initial: string;
  readonly onDone: (title: string | null, viaKey: boolean) => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  // What the input started with; the row's title may change while editing.
  const [initial] = useState(props.initial);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (title: string | null, viaKey: boolean): void => {
    if (done.current) return;
    done.current = true;
    // An untouched title is a cancel, even if the chat was renamed meanwhile.
    const changed =
      title !== null &&
      normalizeSessionTitle(title) !== normalizeSessionTitle(initial);
    props.onDone(changed ? title : null, viaKey);
  };
  const saveOnOutsideClick = useEffectEvent((event: MouseEvent) => {
    const input = ref.current;
    if (input && event.target instanceof Node && !input.contains(event.target))
      finish(input.value, false);
  });
  useEffect(() => {
    // Capture a completed click/tap before its target can close the sidebar.
    document.addEventListener("click", saveOnOutsideClick, true);
    return (): void => {
      document.removeEventListener("click", saveOnOutsideClick, true);
    };
  }, []);
  return (
    <input
      ref={ref}
      className="ohb-session-rename"
      aria-label="Rename chat"
      autoComplete="off"
      spellCheck={false}
      maxLength={SESSION_TITLE_MAX_LENGTH}
      defaultValue={initial}
      onKeyDown={(event) => {
        if (isImeComposing(event)) return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === "Enter" ? event.currentTarget.value : null, true);
      }}
      onBlur={() => {
        requestAnimationFrame(() => {
          const input = ref.current;
          if (done.current || !input || document.activeElement === input)
            return;
          // Another window took focus: keep editing until the user is back.
          if (!document.hasFocus()) return;
          const active = document.activeElement;
          if (active === null || active === document.body) {
            // A list reorder moved the input and dropped its focus.
            input.focus({ preventScroll: true });
            return;
          }
          finish(input.value, false);
        });
      }}
    />
  );
}
