import type {
  ChangeEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import { SlashPalette } from "../commands/SlashPalette.js";
import type { SlashPaletteItem } from "../commands/slashCommands.js";
import { readableError } from "../shared/error-text.js";
import { SkillTokenField } from "../shared/SkillTokenField.js";
import type { QueuedEditState } from "./draft-storage.js";

/**
 * The composer card: slash palette, the text area, inline feedback and the
 * control row passed as `controls`.
 */
export function ComposerInput(props: {
  readonly inputRef: RefObject<HTMLDivElement | null>;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly planMode: boolean;
  readonly compact: boolean;
  /** The request after the skill token, when there is one. */
  readonly draft: string;
  /** The skill token; the side chat passes none. */
  readonly skillName?: string | null;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onChange: (nextDraft: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly slash: {
    readonly open: boolean;
    readonly items: readonly SlashPaletteItem[];
    readonly selectedIndex: number;
    readonly error: string | null;
    readonly onHover: (index: number) => void;
    readonly onRun: (item: SlashPaletteItem) => void;
  };
  readonly queueError: string | null;
  readonly queuedEdit: QueuedEditState | null;
  readonly controls: ReactNode;
}): ReactElement {
  const { slash, queuedEdit } = props;
  return (
    <div
      className={`ohb-composer-input${props.planMode ? " is-plan" : ""}`}
      ref={props.inputRef}
    >
      {slash.open ? (
        <SlashPalette
          items={slash.items}
          onHover={slash.onHover}
          onRun={slash.onRun}
          placement={props.compact ? "down" : "up"}
          selectedIndex={slash.selectedIndex}
        />
      ) : null}
      <div className="ohb-composer-text">
        <SkillTokenField skillName={props.skillName ?? null}>
          <textarea
          aria-label={props.ariaLabel}
          disabled={props.disabled}
          readOnly={props.readOnly}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            props.onChange(event.target.value);
          }}
          onKeyDown={props.onKeyDown}
          placeholder={props.skillName ? "" : props.placeholder}
          ref={props.textareaRef}
          rows={1}
          value={props.draft}
        />
        </SkillTokenField>
      </div>
      {slash.error || props.queueError || queuedEdit ? (
        <div className="ohb-composer-feedback">
          {slash.error ? (
            <span className="ohb-slash-error">
              {readableError(slash.error)}
            </span>
          ) : null}
          {props.queueError ? (
            <span className="ohb-slash-error">
              {readableError(props.queueError)}
            </span>
          ) : null}
          {queuedEdit ? (
            <span className="ohb-composer-hint ohb-queued-edit-hint">
              {queuedEdit.retainedSendText !== undefined
                ? "Retained send · Enter retry the same send"
                : queuedEdit.status === "retained"
                  ? "Editing retained prompt · Enter send"
                  : "Editing queued prompt · Enter save"}{" "}
              · Esc restore draft
            </span>
          ) : null}
        </div>
      ) : null}
      {props.controls}
    </div>
  );
}
