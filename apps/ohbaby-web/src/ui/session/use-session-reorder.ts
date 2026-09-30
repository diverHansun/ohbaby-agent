import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Capture before a pin mutation, animate the same keyed rows after React commits. */
export function useSessionReorder(
  listRef: RefObject<HTMLDivElement | null>,
  order: string,
): { prepare: (focus: HTMLElement | null) => void; reordering: boolean } {
  const pending = useRef<{
    positions: Map<string, number>;
    scrollTop: number;
    focus: HTMLElement | null;
  } | null>(null);
  const animations = useRef<Animation[]>([]);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [reordering, setReordering] = useState(false);
  const prepare = (focus: HTMLElement | null): void => {
    const list = listRef.current;
    if (!list) return;
    const positions = new Map<string, number>();
    for (const row of list.querySelectorAll<HTMLElement>("[data-session-id]")) {
      positions.set(
        row.dataset.sessionId ?? "",
        row.getBoundingClientRect().top,
      );
    }
    // Read current visual positions before interrupting an in-flight animation.
    animations.current.forEach((animation) => {
      animation.cancel();
    });
    animations.current = [];
    clearTimeout(timeout.current);
    pending.current = { positions, scrollTop: list.scrollTop, focus };
  };
  useLayoutEffect(() => {
    const before = pending.current;
    const list = listRef.current;
    if (!before || !list) return;
    pending.current = null;
    list.scrollTop = before.scrollTop;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      for (const row of list.querySelectorAll<HTMLElement>(
        "[data-session-id]",
      )) {
        const previous = before.positions.get(row.dataset.sessionId ?? "");
        if (previous === undefined || typeof row.animate !== "function")
          continue;
        const distance = previous - row.getBoundingClientRect().top;
        if (Math.abs(distance) < 1) continue;
        animations.current.push(
          row.animate(
            [
              { transform: `translateY(${String(distance)}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          ),
        );
      }
    }
    if (before.focus?.isConnected) before.focus.focus({ preventScroll: true });
    setReordering(animations.current.length > 0);
    timeout.current = setTimeout(() => {
      animations.current = [];
      setReordering(false);
    }, 220);
  }, [order, listRef]);
  useLayoutEffect(
    () => (): void => {
      clearTimeout(timeout.current);
      animations.current.forEach((animation) => {
        animation.cancel();
      });
    },
    [],
  );
  return { prepare, reordering };
}
