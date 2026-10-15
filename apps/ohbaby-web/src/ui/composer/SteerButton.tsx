import { useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  UiPromptSubmission,
  UiSteerQueuedPromptInput,
  UiSteerQueuedPromptResult,
} from "ohbaby-sdk";
export function SteerButton(props: {
  readonly prompt: UiPromptSubmission;
  readonly runId?: string;
  readonly disabled: boolean;
  readonly steer: (
    input: UiSteerQueuedPromptInput,
  ) => Promise<UiSteerQueuedPromptResult>;
  readonly onAccepted?: () => void;
}): ReactElement {
  const attempt = useRef<UiSteerQueuedPromptInput | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const disabled =
    props.disabled ||
    !props.runId ||
    pending ||
    accepted ||
    props.prompt.status !== "queued" ||
    Boolean(props.prompt.editLeaseOwnerId) ||
    (attempt.current !== undefined &&
      attempt.current.expectedRunId !== props.runId);
  return (
    <span className="ohb-prompt-queue-steer">
      <button
        type="button"
        disabled={disabled}
        title="Send this queued prompt to the active run at its next safe boundary"
        aria-label={`Steer queued prompt: ${props.prompt.text}`}
        onClick={() => {
          if (disabled || !props.runId) return;
          const input = attempt.current ?? {
            promptId: props.prompt.promptId,
            expectedRunId: props.runId,
            clientRequestId: crypto.randomUUID(),
          };
          attempt.current = input;
          setPending(true);
          setError(undefined);
          void props
            .steer(input)
            .then(
              (result) => {
                if (result.status === "steered") {
                  setAccepted(true);
                  props.onAccepted?.();
                } else {
                  setNotice(
                    result.reason === "prompt-not-queued"
                      ? "Prompt is no longer queued"
                      : `Kept in queue · ${result.reason}`,
                  );
                }
              },
              (caught: unknown) => {
                setError(
                  caught instanceof Error ? caught.message : String(caught),
                );
              },
            )
            .finally(() => {
              setPending(false);
            });
        }}
      >
        {pending ? "Steering…" : accepted ? "Accepted" : "Steer"}
      </button>
      {notice ? <small role="status">{notice}</small> : null}
      {error ? (
        <small role="alert">{error} · Retry uses the original target</small>
      ) : null}
    </span>
  );
}
