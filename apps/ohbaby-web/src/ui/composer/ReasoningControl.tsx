import { Brain, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import type { ReasoningState } from "./useReasoning.js";

/** Why a chosen level is not sent yet, for titles and screen readers. */
function inactiveReasoningText(level: string): string {
  return `${level} isn't active until Reasoning Effort is detected; the service default is used`;
}

/** The desktop Reasoning Effort control: a native select inside the composer row. */
export function ReasoningControl(props: {
  readonly state: ReasoningState;
}): ReactElement | null {
  const { state } = props;
  if (state.kind === "hidden") return null;
  const inactive =
    state.kind !== "choice" && state.inactive !== undefined
      ? inactiveReasoningText(state.inactive)
      : undefined;
  if (state.kind === "detecting")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-detecting"
        aria-label={
          inactive
            ? `Detecting Reasoning Effort; ${inactive}`
            : "Detecting Reasoning Effort"
        }
        role="status"
        title={inactive ?? state.reason}
      >
        <Brain className="ohb-reasoning-pending" aria-hidden="true" size={14} />
      </span>
    );
  if (state.kind === "unknown")
    return (
      <span
        className="ohb-reasoning-status ohb-reasoning-unknown"
        title={inactive ?? state.reason}
      >
        <Brain aria-hidden="true" size={14} />
        {state.inactive ? `${state.inactive} · inactive` : "unknown"}
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
