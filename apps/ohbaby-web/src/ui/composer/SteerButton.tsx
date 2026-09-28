import { useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  UiPromptSubmission,
  UiSteerQueuedPromptInput,
  UiSteerQueuedPromptReceipt,
} from "ohbaby-sdk";
export function SteerButton(props: {
  readonly prompt: UiPromptSubmission;
  readonly runId?: string;
  readonly disabled: boolean;
  readonly steer: (
    input: UiSteerQueuedPromptInput,
  ) => Promise<UiSteerQueuedPromptReceipt>;
  readonly onAccepted: () => void;
}): ReactElement {
  const attempt = useRef<UiSteerQueuedPromptInput | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
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
              () => {
                setAccepted(true);
                props.onAccepted();
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
      {error ? (
        <small role="alert">{error} · Retry uses the original target</small>
      ) : null}
    </span>
  );
}
