import type { UiWebCommandCatalog } from "ohbaby-sdk";
import { LoaderCircle } from "lucide-react";
import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
import { SlashPalette } from "../commands/SlashPalette.js";
import { dropSlashQuery } from "../commands/slashCommands.js";
import { fitComposerTextarea } from "../composer/composerTextarea.js";
import { isImeComposing } from "../composer/ime.js";
import { useSkillPalette } from "../composer/useSkillPalette.js";
import {
  placeCaretAtStart,
  shouldRemoveSkillToken,
  SkillTokenField,
} from "../shared/SkillTokenField.js";

const TEXTAREA_FIT = { lineHeight: 24, maxLines: 12 } as const;

/** What the editor sends: the skill token and the request, kept apart. */
export interface EditedPrompt {
  readonly skill: string | null;
  readonly text: string;
}

/**
 * A user message being edited in place (frontend design §5.1). Send rewinds
 * the chat to this message and sends the new text as the next turn; the hint
 * line says what that removes, so no confirmation follows.
 */
export function UserMessageEditor(props: {
  /** The skill token of the message, from its skill marker. */
  readonly initialSkill: string | null;
  /** The request after the token, or the whole text without one. */
  readonly initialText: string;
  /** What Send will do besides sending, joined by " · ". */
  readonly hints: readonly string[];
  /** The command catalog, for the skills-only palette. */
  readonly listCommands?: () => Promise<UiWebCommandCatalog>;
  readonly commandCatalogVersion?: string | null;
  /** Resolves to an error text to show, or null once the edit is done. */
  readonly onSend: (input: EditedPrompt) => Promise<string | null>;
  readonly onCancel: () => void;
}): ReactElement {
  const [skill, setSkill] = useState(props.initialSkill);
  const [text, setText] = useState(props.initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const palette = useSkillPalette({
    text,
    disabled: sending,
    listCommands: props.listCommands,
    commandCatalogVersion: props.commandCatalogVersion,
    onSelect: (name) => {
      setError(null);
      setSkill(name);
      setText(dropSlashQuery(text));
      placeCaretAtStart(textarea.current);
    },
  });
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useLayoutEffect(() => {
    if (textarea.current) fitComposerTextarea(textarea.current, TEXTAREA_FIT);
  }, [text, skill]);
  // A token alone is something to send.
  const canSend = (skill !== null || text.trim() !== "") && !sending;
  const send = (): void => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    void props.onSend({ skill, text: text.trim() }).then((failure) => {
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
        {palette.open ? (
          <SlashPalette
            items={palette.items}
            onHover={palette.setIndex}
            onRun={palette.select}
            placement="down"
            selectedIndex={palette.index}
          />
        ) : null}
        <SkillTokenField skillName={skill}>
          <textarea
            ref={textarea}
            aria-label="Message"
            rows={1}
            value={text}
            readOnly={sending}
            onChange={(event) => {
              setText(event.target.value);
              palette.onEdited(event.target.value);
            }}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              // Esc and Enter go to an open palette first.
              if (palette.handleKey(event)) {
                event.stopPropagation();
                return;
              }
              if (
                skill !== null &&
                !sending &&
                shouldRemoveSkillToken(event, event.currentTarget)
              ) {
                event.preventDefault();
                setError(null);
                setSkill(null);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!sending) props.onCancel();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
        </SkillTokenField>
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
