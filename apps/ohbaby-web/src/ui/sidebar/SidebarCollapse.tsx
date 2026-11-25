import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type TransitionEvent,
} from "react";

export type SidebarCollapseVariant = "section" | "group";

type CollapsePhase = "closed" | "entering" | "opening" | "open" | "closing";

/** Slightly longer than the CSS durations in sidebar.css so missed transitionend events still settle. */
const FALLBACK_MS: Readonly<
  Record<
    SidebarCollapseVariant,
    { readonly open: number; readonly close: number }
  >
> = {
  section: { open: 260, close: 210 },
  group: { open: 220, close: 180 },
};

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Pure-CSS height and opacity fold for sidebar sections and workspace groups.
 * Unmounts children while closed so hidden rows stay out of the DOM and tab order,
 * and falls back to instant toggling when reduced motion is preferred or layout height is 0.
 */
export function SidebarCollapse(props: {
  readonly open: boolean;
  readonly variant: SidebarCollapseVariant;
  readonly children: ReactNode;
}): ReactElement | null {
  const { open, variant } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<CollapsePhase>(() =>
    open ? "open" : "closed",
  );

  useLayoutEffect(() => {
    if (open) {
      if (phase === "closed") {
        setPhase(prefersReducedMotion() ? "open" : "entering");
      } else if (phase === "closing") {
        setPhase(prefersReducedMotion() ? "open" : "opening");
      }
      return;
    }
    if (phase === "closed" || phase === "closing") return;
    const height = rootRef.current?.getBoundingClientRect().height ?? 0;
    if (prefersReducedMotion() || phase === "entering" || height <= 0) {
      setPhase("closed");
    } else {
      setPhase("closing");
    }
  }, [open, phase]);

  useEffect(() => {
    if (phase === "entering") {
      let innerFrame = 0;
      const outerFrame = requestAnimationFrame(() => {
        innerFrame = requestAnimationFrame(() => {
          setPhase("opening");
        });
      });
      return (): void => {
        cancelAnimationFrame(outerFrame);
        cancelAnimationFrame(innerFrame);
      };
    }
    if (phase === "opening" || phase === "closing") {
      const delay =
        phase === "opening"
          ? FALLBACK_MS[variant].open
          : FALLBACK_MS[variant].close;
      const timer = setTimeout(() => {
        setPhase(phase === "opening" ? "open" : "closed");
      }, delay);
      return (): void => {
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [phase, variant]);

  if (phase === "closed") return null;

  const isOpen = phase === "opening" || phase === "open";
  const isAnimating = phase !== "open";
  const isClosing = phase === "closing";

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (
      event.target !== rootRef.current ||
      event.propertyName !== "grid-template-rows"
    )
      return;
    if (phase === "opening") setPhase("open");
    else if (phase === "closing") setPhase("closed");
  };

  return (
    <div
      ref={rootRef}
      className={`ohb-collapse ohb-collapse-${variant}${isOpen ? " is-open" : ""}${isAnimating ? " is-animating" : ""}`}
      inert={isClosing}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="ohb-collapse-inner">{props.children}</div>
    </div>
  );
}
