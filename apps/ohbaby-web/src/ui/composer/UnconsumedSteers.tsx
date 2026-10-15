import { useRef, useState, type ReactElement } from "react";
import type {
  UiBackendClient,
  UiResendSteerInput,
  UiUnconsumedSteer,
} from "ohbaby-sdk";

function steerStateLabel(state: UiUnconsumedSteer["state"]): string {
  return state === "unconfirmed" ? "Processing unconfirmed" : "Not processed";
}

export function UnconsumedSteers(props: {
  readonly inputs: readonly UiUnconsumedSteer[];
  readonly disabled: boolean;
  readonly resend: UiBackendClient["resendSteerInput"];
  /** Session scope: remounts only on session change, so pending retry ids survive collapse. */
  readonly scopeKey: string;
}): ReactElement | null {
  const count = props.inputs.length;
  if (count === 0) return null;
  const firstState = props.inputs[0].state;
  const hasUniformState = props.inputs.every(
    (item) => item.state === firstState,
  );
  const summaryStateLabel = hasUniformState
    ? steerStateLabel(firstState)
    : null;

  return (
    <details
      key={props.scopeKey}
      className="ohb-unsent-steer"
      aria-label="Steer inputs needing recovery"
    >
      <summary>
        <SteerChevronIcon />
        <span className="ohb-unsent-steer-count">
          {String(count)} input{count === 1 ? "" : "s"} to review
        </span>
        {summaryStateLabel ? (
          <span className="ohb-unsent-steer-state" role="status">
            · {summaryStateLabel}
          </span>
        ) : null}
      </summary>
      <div className="ohb-steer-recovery-list">
        {props.inputs.map((input, index) => (
          <RecoveryInput
            key={input.inputId}
            input={input}
            index={index}
            disabled={props.disabled}
            resend={props.resend}
            showState={!hasUniformState}
          />
        ))}
      </div>
    </details>
  );
}

function RecoveryInput(props: {
  readonly input: UiUnconsumedSteer;
  readonly index: number;
  readonly disabled: boolean;
  readonly resend: UiBackendClient["resendSteerInput"];
  readonly showState: boolean;
}): ReactElement {
  const attempt = useRef<UiResendSteerInput | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  return (
    <div className="ohb-steer-recovery-item">
      <div className="ohb-steer-recovery-body">
        <pre
          className="ohb-steer-recovery-text"
          tabIndex={0}
          aria-label="Original steer text"
        >
          {props.input.text}
        </pre>
        {props.showState ? (
          <span className="ohb-steer-recovery-state" role="status">
            {steerStateLabel(props.input.state)}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        aria-busy={pending || undefined}
        className="ohb-steer-recovery-resend"
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
        <SteerResendIcon />
        <span>
          {pending ? "Resending…" : resent ? "Resend again" : "Resend"}
        </span>
      </button>
    </div>
  );
}

function SteerChevronIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ohb-unsent-steer-chevron"
      fill="none"
      height="12"
      viewBox="0 0 12 12"
      width="12"
    >
      <path
        d="M4.5 2.75 7.75 6 4.5 9.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function SteerResendIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ohb-steer-recovery-resend-icon"
      fill="none"
      height="12"
      viewBox="0 0 14 14"
      width="12"
    >
      <path
        d="M11.5 7a4.5 4.5 0 1 1-1.15-3.01M11.5 2.5v2.1h-2.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}
