import type { ReactElement } from "react";

/** An inline error at the place it happened, with a dismiss action. */
export function ErrorBanner(props: {
  readonly message: string | null;
  readonly onDismiss: () => void;
}): ReactElement | null {
  if (!props.message) {
    return null;
  }
  return (
    <div className="ohb-error-banner" role="alert">
      <span>{props.message}</span>
      <button onClick={props.onDismiss} type="button">
        Dismiss
      </button>
    </div>
  );
}
