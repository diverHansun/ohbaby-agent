import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

/** A shorter press is a click, as in opencode and dsh. */
const DRAG_THRESHOLD = 4;

interface Press {
  readonly id: string;
  readonly startX: number;
  /** The tab's left edge on screen when pressed. */
  readonly startLeft: number;
  dragging: boolean;
}

export interface TabDrag {
  /** The tab being dragged, for its lifted look. */
  readonly draggingId: string | undefined;
  readonly onPointerDown: (
    id: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}

/**
 * Drags tabs along a strip like browser tabs (03 §4.9). Past the threshold the
 * tab is selected and follows the pointer inside the strip; it trades places
 * with a neighbour as soon as its middle crosses the neighbour's. Only the
 * order changes, so no page remounts. Mouse and pen only: a finger keeps
 * scrolling the strip. Each tab element carries its id in `data-side-tab`.
 */
export function useTabDrag(props: {
  readonly list: RefObject<HTMLElement | null>;
  readonly select: (id: string) => void;
  readonly move: (id: string, targetId: string) => void;
}): TabDrag {
  const { list, select, move } = props;
  const press = useRef<Press | null>(null);
  const release = useRef<(() => void) | null>(null);
  const [draggingId, setDraggingId] = useState<string>();
  useEffect(
    () => (): void => {
      release.current?.();
    },
    [],
  );

  const tabs = (): HTMLElement[] => [
    ...(list.current?.querySelectorAll<HTMLElement>("[data-side-tab]") ?? []),
  ];
  const drag = (current: Press, x: number): void => {
    if (!current.dragging) {
      if (Math.abs(x - current.startX) < DRAG_THRESHOLD) return;
      current.dragging = true;
      setDraggingId(current.id);
      select(current.id);
    }
    const all = tabs();
    const tab = all.find((element) => element.dataset.sideTab === current.id);
    const bounds = list.current?.getBoundingClientRect();
    if (!tab || !bounds) return;
    // The transform is set here rather than through React, so a drag never
    // re-renders the page beside it.
    tab.style.transform = "";
    const home = tab.getBoundingClientRect();
    const left = Math.max(
      bounds.left,
      Math.min(
        bounds.right - home.width,
        current.startLeft + x - current.startX,
      ),
    );
    const middle = left + home.width / 2;
    const others = all.filter((element) => element !== tab);
    const slot = others.findIndex((element) => {
      const rect = element.getBoundingClientRect();
      return middle < rect.left + rect.width / 2;
    });
    const target = all[slot < 0 ? others.length : slot]?.dataset.sideTab;
    let shown = home.left;
    if (target && target !== current.id) {
      // Commit now, so the next pointer move measures the new order.
      flushSync(() => {
        move(current.id, target);
      });
      shown = tab.getBoundingClientRect().left;
    }
    tab.style.transform = `translateX(${String(left - shown)}px)`;
  };
  const end = (): void => {
    release.current?.();
    const current = press.current;
    press.current = null;
    if (!current?.dragging) return;
    const tab = tabs().find(
      (element) => element.dataset.sideTab === current.id,
    );
    if (tab) {
      tab.style.transform = "";
      // Moving a focused element in the DOM drops its focus; a click keeps it.
      tab.querySelector<HTMLElement>('[role="tab"]')?.focus({
        preventScroll: true,
      });
    }
    setDraggingId(undefined);
  };

  return {
    draggingId,
    onPointerDown: (id, event): void => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      release.current?.();
      const current: Press = {
        id,
        startX: event.clientX,
        startLeft: event.currentTarget.getBoundingClientRect().left,
        dragging: false,
      };
      press.current = current;
      const { pointerId } = event;
      // The window, not the tab, listens: reordering moves tab elements.
      const onMove = (moved: PointerEvent): void => {
        if (moved.pointerId === pointerId) drag(current, moved.clientX);
      };
      const onEnd = (ended: PointerEvent): void => {
        if (ended.pointerId === pointerId) end();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      release.current = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        release.current = null;
      };
    },
  };
}
