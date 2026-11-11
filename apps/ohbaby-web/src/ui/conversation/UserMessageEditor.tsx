import { LoaderCircle } from "lucide-react";
import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
import { fitComposerTextarea } from "../composer/composerTextarea.js";
import { isImeComposing } from "../composer/ime.js";

const TEXTAREA_FIT = { lineHeight: 24, maxLines: 12 } as const;

/**
 * A user message being edited in place (frontend design §5.1). Send rewinds
 * the chat to this message and sends the new text as the next turn; the hint
 * line says what that removes, so no confirmation follows.
 */
export function UserMessageEditor(props: {
  readonly initialText: string;
  /** What Send will do besides sending, joined by " · ". */
  readonly hints: readonly string[];
  /** Resolves to an error text to show, or null once the edit is done. */
  readonly onSend: (text: string) => Promise<string | null>;
  readonly onCancel: () => void;
}): ReactElement {
  const [text, setText] = useState(props.initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useLayoutEffect(() => {
    if (textarea.current) fitComposerTextarea(textarea.current, TEXTAREA_FIT);
  }, [text]);
  const canSend = text.trim() !== "" && !sending;
  const send = (): void => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    void props.onSend(text.trim()).then((failure) => {
      // On success the message is gone and this editor with it.
      if (failure === null) return;
      setError(failure);
      setSending(false);
    });
  };
  return (
    <div className="ohb-message ohb-message-user">
      <form
        className="ohb-message-editor"
        aria-label="Edit message"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={textarea}
          aria-label="Message"
          rows={1}
          value={text}
          readOnly={sending}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!sending) props.onCancel();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {error ? (
          <p className="ohb-message-editor-hint is-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="ohb-message-editor-hint">{props.hints.join(" · ")}</p>
        )}
        <div className="ohb-message-editor-actions">
          <button
            type="button"
            className="ohb-text-button"
            disabled={sending}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="ohb-message-editor-send"
            disabled={!canSend}
            aria-busy={sending}
          >
            {sending ? (
              <LoaderCircle
                aria-hidden="true"
                className="ohb-send-spinner"
                size={13}
              />
            ) : null}
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
