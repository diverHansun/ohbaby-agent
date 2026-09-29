import { ChevronRight } from "lucide-react";
import type { UiRun } from "ohbaby-sdk";
import type { ReactElement } from "react";
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
    request.runId !== run.id ||
    request.purpose !== "agent-step" ||
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

export function PromptDuration({
  prompt,
  disclosure,
}: {
  readonly prompt: import("ohbaby-sdk").UiPromptSubmission;
  readonly disclosure?: {
    readonly open: boolean;
    readonly controls: string;
    readonly id: string;
    readonly onToggle: () => void;
  };
}): ReactElement {
  const duration = useExecutionDuration(
    prompt.promptId,
    prompt.endTimeSource === "recovery"
      ? undefined
      : Date.parse(prompt.acceptedAt ?? prompt.createdAt),
    prompt.endedAt === undefined ? undefined : Date.parse(prompt.endedAt),
  );
  const label =
    prompt.endTimeSource === "recovery"
      ? `${prompt.status} · End time unknown (recovered)`
      : `${prompt.status !== "succeeded" ? `${prompt.status} · ` : ""}Total ${duration ?? "—"}`;
  return disclosure ? (
    <button
      type="button"
      className="ohb-prompt-duration ohb-run-disclosure"
      id={disclosure.id}
      aria-expanded={disclosure.open}
      aria-controls={disclosure.controls}
      onClick={disclosure.onToggle}
    >
      <span>{label}</span>
      <ChevronRight size={16} className="ohb-run-chevron" aria-hidden="true" />
    </button>
  ) : (
    <div className="ohb-prompt-duration">{label}</div>
  );
}
