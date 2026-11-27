import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Messages taller than this many lines fold to about eight (messages.css). */
const FOLD_LINES = 12;
const FALLBACK_LINE_HEIGHT_PX = 23.8;

/**
 * A long user message folds to about eight lines with Show more / Show less
 * (frontend 05 §2.3). `expandSignal` is the search jump's token: when it
 * changes, the message opens.
 */
export function CollapsibleUserText(props: {
  readonly children: ReactNode;
  readonly expandSignal?: string;
  /** Markdown (From parent) cannot be cut by line; it folds by height. */
  readonly rich?: boolean;
}): ReactElement {
  const id = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [foldable, setFoldable] = useState(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = (): void => {
      const lineHeight =
        Number.parseFloat(getComputedStyle(body).lineHeight) ||
        FALLBACK_LINE_HEIGHT_PX;
      setFoldable(body.scrollHeight > lineHeight * FOLD_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => {
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (props.expandSignal !== undefined) setExpanded(true);
  }, [props.expandSignal]);
  const folded = foldable && !expanded;
  return (
    <>
      <div
        ref={bodyRef}
        id={id}
        className={`ohb-user-text${props.rich ? " is-rich" : ""}${folded ? " is-folded" : ""}`}
      >
        {props.children}
      </div>
      {foldable ? (
        <button
          type="button"
          className="ohb-user-text-toggle"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? (
            <ChevronUp size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
        </button>
      ) : null}
    </>
  );
}
