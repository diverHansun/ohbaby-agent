import { useRef, useState, type ReactElement } from "react";
import type {
  UiBackendClient,
  UiResendSteerInput,
  UiUnconsumedSteer,
} from "ohbaby-sdk";

export function UnconsumedSteers(props: {
  readonly inputs: readonly UiUnconsumedSteer[];
  readonly disabled: boolean;
  readonly resend: UiBackendClient["resendSteerInput"];
  /** Session scope: remounts only on session change, so pending retry ids survive collapse. */
  readonly scopeKey: string;
}): ReactElement | null {
  const count = props.inputs.length;
  if (count === 0) return null;
  return (
    <details
      key={props.scopeKey}
      className="ohb-unsent-steer"
      aria-label="Steer inputs needing recovery"
    >
      <summary>
        {String(count)} input{count === 1 ? "" : "s"} to review
      </summary>
      {props.inputs.map((input, index) => (
        <RecoveryInput
          key={input.inputId}
          input={input}
          index={index}
          disabled={props.disabled}
          resend={props.resend}
        />
      ))}
    </details>
  );
}

function RecoveryInput(props: {
  readonly input: UiUnconsumedSteer;
  readonly index: number;
  readonly disabled: boolean;
  readonly resend: UiBackendClient["resendSteerInput"];
}): ReactElement {
  const attempt = useRef<UiResendSteerInput | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  return (
    <div className="ohb-steer-recovery-item">
      <p role="status">
        {props.input.state === "unconfirmed"
          ? "Processing unconfirmed"
          : "Not processed"}
      </p>
      <pre
        className="ohb-steer-recovery-text"
        tabIndex={0}
        aria-label="Original steer text"
      >
        {props.input.text}
      </pre>
      <button
        type="button"
        className="ohb-button"
        disabled={props.disabled || pending}
        aria-label={`Resend steer ${String(props.index + 1)}: ${props.input.text.slice(0, 80)}`}
        onClick={() => {
          const input = attempt.current ?? {
            inputId: props.input.inputId,
            operationId: crypto.randomUUID(),
          };
          attempt.current = input;
          setPending(true);
          void props
            .resend(input)
            .then(
              () => {
                attempt.current = undefined;
                setResent(true);
              },
              () => {
                // Keep the operationId for an idempotent retry; the composer shows the error.
              },
            )
            .finally(() => {
              setPending(false);
            });
        }}
      >
        {pending ? "Resending…" : resent ? "Resend again" : "Resend"}
      </button>
    </div>
  );
}
