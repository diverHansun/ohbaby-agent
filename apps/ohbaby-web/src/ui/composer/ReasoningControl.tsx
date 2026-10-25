import { Brain, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import type { ReasoningState } from "./useReasoning.js";

/** The desktop thinking-effort control: a native select inside the composer row. */
export function ReasoningControl(props: {
  readonly state: ReasoningState;
}): ReactElement | null {
  const { state } = props;
  if (state.kind === "hidden") return null;
  if (state.kind === "detecting")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-detecting"
        aria-label="Detecting reasoning effort"
        role="status"
        title={state.reason}
      >
        <Brain className="ohb-reasoning-spinner" aria-hidden="true" size={14} />
      </span>
    );
  if (state.kind === "unknown")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-unknown"
        title={state.reason}
      >
        <Brain aria-hidden="true" size={14} />
        unknown
      </span>
    );
  return (
    <label
      className="ohb-reasoning-control"
      title={state.error ?? "Reasoning effort"}
    >
      <Brain className="ohb-reasoning-icon" aria-hidden="true" size={14} />
      <select
        aria-label="Reasoning effort"
        aria-invalid={state.error ? true : undefined}
        value={state.value}
        onChange={(event) => {
          state.select(event.target.value);
        }}
      >
        {state.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="ohb-reasoning-chevron"
        aria-hidden="true"
        size={13}
      />
      {state.error && (
        <span className="ohb-reasoning-error" role="alert">
          {state.error}
        </span>
      )}
    </label>
  );
}
