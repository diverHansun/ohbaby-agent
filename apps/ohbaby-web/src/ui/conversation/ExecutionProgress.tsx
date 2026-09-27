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
}: {
  readonly prompt: import("ohbaby-sdk").UiPromptSubmission;
}): ReactElement {
  const duration = useExecutionDuration(
    prompt.promptId,
    Date.parse(prompt.createdAt),
    prompt.endedAt === undefined ? undefined : Date.parse(prompt.endedAt),
  );
  return (
    <div className="ohb-prompt-duration">
      {prompt.status !== "succeeded" ? `${prompt.status} · ` : ""}Total{" "}
      {duration ?? "—"}
    </div>
  );
}
