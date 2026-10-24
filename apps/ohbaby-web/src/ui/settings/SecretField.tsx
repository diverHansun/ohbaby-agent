import type { ReactElement } from "react";
import { useEffect, useRef } from "react";
import type { SecretChange } from "./secret.js";

/**
 * API key display and edit (05 SecretField). The saved key is never shown:
 * only Configured or Not set, with Replace, Clear or Add key. A replacement
 * is typed into a password field that is not autofilled.
 */
export function SecretField(props: {
  readonly id: string;
  readonly configured: boolean;
  readonly value: SecretChange;
  readonly onChange: (next: SecretChange) => void;
  /** A new entry has no saved key: the field starts as an input. */
  readonly startEditing?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusOnEdit = useRef(false);
  const editing = typeof props.value === "object";
  useEffect(() => {
    if (editing && focusOnEdit.current) {
      focusOnEdit.current = false;
      inputRef.current?.focus();
    }
  }, [editing]);
  const replace = (): void => {
    focusOnEdit.current = true;
    props.onChange({ replace: "" });
  };
  if (editing || props.startEditing) {
    const text = typeof props.value === "object" ? props.value.replace : "";
    return (
      <span className="ohb-secret-field">
        <input
          ref={inputRef}
          id={props.id}
          className="ohb-settings-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.configured ? "New key" : "Paste a key"}
          aria-invalid={props.invalid ? true : undefined}
          aria-describedby={props.describedBy}
          value={text}
          onChange={(event) => {
            props.onChange({ replace: event.target.value });
          }}
        />
        {props.startEditing ? null : (
          <button
            type="button"
            className="ohb-text-button"
            onClick={() => {
              props.onChange("keep");
            }}
          >
            Cancel
          </button>
        )}
      </span>
    );
  }
  const shownConfigured = props.configured && props.value !== "clear";
  return (
    <span className="ohb-secret-field">
      <span
        id={props.id}
        className={`ohb-secret-state${shownConfigured ? "" : " is-empty"}`}
      >
        {shownConfigured ? "Configured" : "Not set"}
      </span>
      {props.value === "clear" ? (
        <button
          type="button"
          className="ohb-text-button"
          onClick={() => {
            props.onChange("keep");
          }}
        >
          Undo
        </button>
      ) : props.configured ? (
        <>
          <button type="button" className="ohb-text-button" onClick={replace}>
            Replace
          </button>
          <button
            type="button"
            className="ohb-text-button"
            onClick={() => {
              props.onChange("clear");
            }}
          >
            Clear
          </button>
        </>
      ) : (
        <button type="button" className="ohb-text-button" onClick={replace}>
          Add key
        </button>
      )}
    </span>
  );
}
