import type {
  ChangeEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import { SlashPalette } from "../commands/SlashPalette.js";
import type { SlashPaletteItem } from "../commands/slashCommands.js";
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
  readonly draft: string;
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
    readonly selected: SlashPaletteItem | undefined;
    readonly completionSuffix: string | null | undefined;
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
        <textarea
          aria-label={props.ariaLabel}
          disabled={props.disabled}
          readOnly={props.readOnly}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            props.onChange(event.target.value);
          }}
          onKeyDown={props.onKeyDown}
          placeholder={props.placeholder}
          ref={props.textareaRef}
          rows={1}
          value={props.draft}
        />
      </div>
      {slash.completionSuffix && slash.selected ? (
        <span className="ohb-slash-completion" aria-hidden="true">
          <span>⇥ {slash.selected.label}</span>
        </span>
      ) : null}
      {slash.error || props.queueError || queuedEdit ? (
        <div className="ohb-composer-feedback">
          {slash.error ? (
            <span className="ohb-slash-error">{slash.error}</span>
          ) : null}
          {props.queueError ? (
            <span className="ohb-slash-error">{props.queueError}</span>
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
