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
}): ReactElement | null {
  if (props.inputs.length === 0) return null;
  return (
    <section
      className="ohb-unsent-steer"
      aria-label="Steer inputs needing recovery"
    >
      {props.inputs.map((input, index) => (
        <RecoveryInput
          key={input.inputId}
          input={input}
          index={index}
          disabled={props.disabled}
          resend={props.resend}
        />
      ))}
    </section>
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
  const [error, setError] = useState<string>();
  const [resent, setResent] = useState(false);
  return (
    <div>
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
          setError(undefined);
          void props
            .resend(input)
            .then(
              () => {
                attempt.current = undefined;
                setResent(true);
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
        {pending ? "Resending…" : resent ? "Resend again" : "Resend"}
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}
