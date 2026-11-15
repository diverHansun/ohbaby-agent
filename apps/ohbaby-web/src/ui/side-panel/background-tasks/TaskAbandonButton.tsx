import { type ReactElement, useEffect, useState } from "react";

/** Same window as the terminal's `y` confirmation. */
const CONFIRM_TIMEOUT_MS = 5000;

/**
 * Releases a task whose process cleanup could not be confirmed. It does not
 * end any process, so the first click only asks for a second one.
 */
export function TaskAbandonButton(props: {
  readonly title: string;
  readonly busy: boolean;
  readonly onAbandon: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => {
      setConfirming(false);
    }, CONFIRM_TIMEOUT_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [confirming]);
  const label = props.busy
    ? "Releasing…"
    : confirming
      ? "Confirm: stop tracking"
      : "Stop tracking";
  return (
    <button
      type="button"
      className="ohb-bgtask-cancel"
      disabled={props.busy}
      aria-label={`${label} ${props.title}`}
      onClick={(event) => {
        event.stopPropagation();
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        props.onAbandon();
      }}
    >
      {label}
    </button>
  );
}
