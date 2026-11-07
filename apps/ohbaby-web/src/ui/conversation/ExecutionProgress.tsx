import { ChevronRight } from "lucide-react";
import type { UiRun } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { TurnTiming } from "./run-process.js";
import { useExecutionDuration } from "./use-execution-duration.js";

export function ModelWaiting({
  run,
}: {
  readonly run: UiRun | undefined;
}): ReactElement | null {
  const request = run?.modelActivity;
  const duration = useExecutionDuration(
    request?.requestId ?? "model",
    request?.startedAt,
    request?.endedAt,
  );
  if (
    !request ||
    run.status.kind !== "running" ||
    request.purpose !== "agent-step" ||
    request.runId !== run.id ||
    request.outcome !== "running" ||
    request.firstTextAt !== undefined ||
    request.endedAt !== undefined
  )
    return null;
  return (
    <div className="ohb-thinking" role="status" aria-label="Thinking">
      <span aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Thinking</span>
      {duration === undefined ? null : <span>· {duration}</span>}
    </div>
  );
}

/** Same three dots as Thinking, squeezed together vertically while history compacts. */
export function Compacting(): ReactElement {
  return (
    <div
      className="ohb-thinking ohb-compacting"
      role="status"
      aria-label="Compacting"
    >
      <span aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Compacting</span>
    </div>
  );
}

/**
 * A turn's end line: total time and, unless it succeeded, how it ended. The
 * name predates turns by run; it now serves any turn, with or without a prompt
 * (turn-projection 00 P12). `label` names what started a non-user turn.
 */
export function PromptDuration({
  timing,
  label: origin,
  disclosure,
}: {
  readonly timing: TurnTiming;
  readonly label?: string;
  readonly disclosure?: {
    readonly open: boolean;
    readonly controls: string;
    readonly id: string;
    readonly onToggle: () => void;
  };
}): ReactElement {
  const duration = useExecutionDuration(
    timing.id,
    timing.startedAt === undefined ? undefined : Date.parse(timing.startedAt),
    Date.parse(timing.endedAt),
  );
  const status =
    timing.status === undefined || timing.status === "succeeded"
      ? ""
      : `${timing.status} · `;
  const result = timing.recovered
    ? `${timing.status ?? "ended"} · End time unknown (recovered)`
    : `${status}Total ${duration ?? "—"}`;
  const label = origin ? `${origin} · ${result}` : result;
  return disclosure ? (
    <div className="ohb-run-header">
      <button
        type="button"
        className="ohb-prompt-duration ohb-run-disclosure"
        id={disclosure.id}
        aria-expanded={disclosure.open}
        aria-controls={disclosure.controls}
        onClick={disclosure.onToggle}
      >
        <span>{label}</span>
        <ChevronRight
          size={16}
          className="ohb-run-chevron"
          aria-hidden="true"
        />
      </button>
    </div>
  ) : (
    <div className="ohb-prompt-duration">{label}</div>
  );
}
