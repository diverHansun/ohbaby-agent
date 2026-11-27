import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { SkillToken } from "./SkillToken.js";

/** Room between the token and the first character typed after it. */
const TOKEN_GAP_PX = 6;

/**
 * Lays a skill token over the top-left of an ordinary textarea and indents the
 * first line by its width (frontend 05 §2.2). The textarea keeps its own
 * height, IME, undo and paste; the token scrolls with the first line.
 */
export function SkillTokenField(props: {
  readonly skillName: string | null;
  readonly children: ReactNode;
}): ReactElement {
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    const token = tokenRef.current;
    if (!field || !token || props.skillName === null) return;
    const textarea = field.querySelector("textarea");
    const measure = (): void => {
      field.style.setProperty(
        "--ohb-skill-indent",
        `${String(token.offsetWidth + TOKEN_GAP_PX)}px`,
      );
    };
    const follow = (): void => {
      token.style.transform = `translateY(${String(-(textarea?.scrollTop ?? 0))}px)`;
    };
    measure();
    follow();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(token);
    textarea?.addEventListener("scroll", follow);
    return () => {
      observer?.disconnect();
      textarea?.removeEventListener("scroll", follow);
      field.style.removeProperty("--ohb-skill-indent");
    };
  }, [props.skillName]);
  return (
    <div
      ref={fieldRef}
      className={`ohb-skill-field${props.skillName === null ? "" : " has-skill"}`}
    >
      {props.children}
      {props.skillName === null ? null : (
        <span ref={tokenRef} className="ohb-skill-field-token">
          <SkillToken name={props.skillName} />
        </span>
      )}
    </div>
  );
}

/**
 * After a token is made or removed, focus stays in the field with the caret
 * at the start of the request (skill UX frontend 04 §3). Runs after React has
 * written the new value, so the caret is not pushed to the end.
 */
export function placeCaretAtStart(
  textarea: HTMLTextAreaElement | null | undefined,
): void {
  requestAnimationFrame(() => {
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
  });
}

/**
 * Backspace at the very start, with nothing selected and no IME composition,
 * removes the token as a whole; the caller clears it and prevents default.
 */
export function shouldRemoveSkillToken(
  event: KeyboardEvent<HTMLTextAreaElement>,
  textarea: HTMLTextAreaElement,
): boolean {
  return (
    event.key === "Backspace" &&
    !event.nativeEvent.isComposing &&
    textarea.selectionStart === 0 &&
    textarea.selectionEnd === 0
  );
}
