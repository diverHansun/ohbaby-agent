import { Archive, MoreHorizontal, Pin } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { SidebarSessionItem } from "../../store/sidebar-groups.js";
import { Spinner } from "../shared/Spinner.js";
import { relativeTime } from "./relative-time.js";
import type { SessionMenuAnchor } from "./SessionMenu.js";

/**
 * One sidebar session (05 SessionRow): the open button, then a trailing
 * spinner (running), amber dot (awaiting approval) or relative time. On hover
 * the time gives way to Archive and the menu.
 */
export function SessionRow(props: {
  readonly session: SidebarSessionItem;
  /** Clock for the relative time; the list passes one value to all rows. */
  readonly now: number;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly pinned: boolean;
  readonly menuOpen: boolean;
  readonly moving: boolean;
  readonly reordering: boolean;
  readonly onSelect: () => void;
  readonly onArchive: (trigger: HTMLButtonElement) => void;
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
  useEffect(() => {
    const titleElement = titleRef.current;
    const text = textRef.current;
    if (
      !titleElement ||
      !text ||
      !hovered ||
      props.menuOpen ||
      props.reordering ||
      props.disabled
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
  }, [hovered, props.menuOpen, props.reordering, props.disabled, title]);

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
  const meta =
    props.session.activity === "running" ? (
      <Spinner size={11} label="Running" />
    ) : props.session.activity === "awaiting" ? (
      <span
        className="ohb-session-awaiting"
        role="status"
        aria-label="Waiting for approval"
      />
    ) : (
      <small>{relativeTime(props.session.updatedAt, props.now)}</small>
    );
  return (
    <div
      ref={rowRef}
      data-session-id={props.session.id}
      className={`ohb-session-row${props.active ? " ohb-session-active" : ""}${props.menuOpen ? " is-menu-open" : ""}`}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      onContextMenu={(event) => {
        if (props.disabled || props.moving || !actionsRef.current) return;
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
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          openAtButton();
        }
      }}
    >
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
          <Pin aria-hidden="true" size={12} fill="currentColor" />
        </button>
      ) : null}
      <button
        ref={mainRef}
        className="ohb-session-main"
        disabled={props.disabled || props.moving}
        aria-current={props.active ? "page" : undefined}
        aria-label={`Select ${title}`}
        onClick={props.onSelect}
        type="button"
      >
        <span className="ohb-session-copy">
          {props.moving ? <Spinner size={11} label="Moving chat" /> : null}
          <strong ref={titleRef} className="ohb-session-title">
            <span ref={textRef}>{title}</span>
          </strong>
          <span className="ohb-session-meta">{meta}</span>
        </span>
      </button>
      <span className="ohb-session-hover-actions">
        <button
          className="ohb-session-archive"
          aria-label={`Archive ${title}`}
          title={`Archive ${title}`}
          disabled={props.disabled || props.moving}
          onClick={(event) => {
            props.onArchive(event.currentTarget);
          }}
          type="button"
        >
          <Archive aria-hidden="true" size={14} />
        </button>
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
    </div>
  );
}
