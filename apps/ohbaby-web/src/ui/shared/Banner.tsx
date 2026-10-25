import { X } from "lucide-react";
import type { ReactElement } from "react";

export type BannerTone = "error" | "attention" | "info";

export interface BannerAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
}

/**
 * An inline notice where it happened: a type dot, the message and optional
 * actions on a plain card (pi-web's notice). Only errors are announced as
 * alerts; `onDismiss` is left out for states that clear themselves.
 */
export function Banner(props: {
  readonly tone: BannerTone;
  readonly message: string | null;
  readonly actions?: readonly BannerAction[];
  readonly onDismiss?: () => void;
}): ReactElement | null {
  if (!props.message) return null;
  return (
    <div
      className={`ohb-banner ohb-banner-${props.tone}`}
      role={props.tone === "error" ? "alert" : "status"}
    >
      <span className="ohb-banner-dot" aria-hidden="true" />
      <span className="ohb-banner-message">{props.message}</span>
      {props.actions?.map((action, index) => (
        <button
          key={`${String(index)}:${action.label}`}
          type="button"
          className="ohb-banner-action"
          disabled={action.disabled}
          title={action.title}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
      {props.onDismiss ? (
        <button
          type="button"
          className="ohb-banner-close"
          aria-label="Dismiss"
          onClick={props.onDismiss}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
