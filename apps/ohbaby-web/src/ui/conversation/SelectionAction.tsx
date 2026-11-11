import type { LucideIcon } from "lucide-react";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const GAP = 8;
const MARGIN = 8;

/**
 * The text selected inside message bodies of `container`, or null: an empty
 * selection, one reaching outside the messages, or one in a text field.
 */
export function readMessageSelection(
  selection: Selection | null,
  container: HTMLElement,
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const inMessage = (node: Node | null): boolean => {
    const element = node instanceof Element ? node : node?.parentElement;
    const body = element?.closest(".ohb-message-body");
    return body !== null && body !== undefined && container.contains(body);
  };
  const range = selection.getRangeAt(0);
  if (!inMessage(range.startContainer)) return null;
  // A triple click ends the selection at the very start of the next block,
  // which for the last paragraph lies outside the messages.
  if (!inMessage(range.endContainer) && range.endOffset !== 0) return null;
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement
  )
    return null;
  const text = selection.toString().trimEnd();
  return text.trim() === "" ? null : text;
}

/**
 * One floating button above the text selected in `container` (frontend design
 * §3.1). It appears once the pointer is released and goes when the selection
 * does; pressing it keeps the selection until the action has read it.
 */
export function SelectionAction(props: {
  readonly container: RefObject<HTMLElement | null>;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onAction: (text: string) => void;
}): ReactElement | null {
  const [target, setTarget] = useState<{
    readonly text: string;
    readonly rect: DOMRect;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { container } = props;
  useEffect(() => {
    let pointerDown = false;
    const read = (): void => {
      const element = container.current;
      const selection = document.getSelection();
      const text =
        element && !pointerDown
          ? readMessageSelection(selection, element)
          : null;
      setTarget(
        text === null || !selection
          ? null
          : { text, rect: selection.getRangeAt(0).getBoundingClientRect() },
      );
    };
    const down = (event: PointerEvent): void => {
      if (button.current?.contains(event.target as Node)) return;
      pointerDown = true;
      setTarget(null);
    };
    const up = (): void => {
      pointerDown = false;
      read();
    };
    document.addEventListener("selectionchange", read);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    // The selection moves with the page; follow it rather than float away.
    window.addEventListener("scroll", read, true);
    window.addEventListener("resize", read);
    return (): void => {
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      window.removeEventListener("scroll", read, true);
      window.removeEventListener("resize", read);
    };
  }, [container]);
  useLayoutEffect(() => {
    const element = button.current;
    if (!element || !target) return;
    const { width, height } = element.getBoundingClientRect();
    const { rect } = target;
    const above = rect.top - GAP - height;
    element.style.top = `${String(above < MARGIN ? rect.bottom + GAP : above)}px`;
    element.style.left = `${String(
      Math.max(
        MARGIN,
        Math.min(
          rect.left + rect.width / 2 - width / 2,
          window.innerWidth - width - MARGIN,
        ),
      ),
    )}px`;
  }, [target]);
  if (!target) return null;
  const Icon = props.icon;
  return createPortal(
    <button
      ref={button}
      type="button"
      className="ohb-selection-action"
      // Keep the selection: a plain press would clear it before the click.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onAction(target.text);
        document.getSelection()?.removeAllRanges();
        setTarget(null);
      }}
    >
      <Icon aria-hidden="true" size={14} />
      {props.label}
    </button>,
    document.body,
  );
}
