import { ArrowUp, ChevronDown, LoaderCircle, Square } from "lucide-react";
import type { UiBackendClient, UiReasoningConfig, UiSession } from "ohbaby-sdk";
import type { ReactElement, ReactNode } from "react";
import { ReasoningControl } from "./ReasoningControl.js";

/**
 * Bottom row inside the composer card: permission control on the left; model,
 * thinking effort and the round send (or Stop) button on the right (D22).
 */
export function ComposerControls(props: {
  readonly client: Pick<
    UiBackendClient,
    "getCurrentModel" | "subscribeEvents" | "updateSessionReasoning"
  >;
  readonly session: UiSession | null;
  readonly permissionControl: ReactNode;
  readonly modelLabel?: string;
  readonly onOpenModel?: () => void;
  readonly onReasoningChange: (
    reasoning: UiReasoningConfig | undefined,
  ) => void;
  readonly showStop: boolean;
  readonly stopLabel?: string;
  readonly canStop: boolean;
  readonly onStop: () => void;
  readonly canSend: boolean;
  readonly sendLabel: string;
  readonly admitting: boolean;
  readonly onSend: () => void;
}): ReactElement {
  return (
    <div className="ohb-composer-bar">
      {props.permissionControl}
      <div className="ohb-composer-bar-spacer" />
      {props.modelLabel ? (
        <button
          type="button"
          className="ohb-control-button ohb-model-button"
          onClick={props.onOpenModel}
          title="Model"
        >
          <span>{props.modelLabel}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </button>
      ) : null}
      <ReasoningControl
        client={props.client}
        session={props.session}
        onChange={props.onReasoningChange}
      />
      {props.showStop ? (
        <button
          aria-busy={props.stopLabel !== undefined}
          aria-label={props.stopLabel ?? "Stop run"}
          className="ohb-stop-button"
          disabled={props.stopLabel !== undefined || !props.canStop}
          onClick={props.onStop}
          title={props.stopLabel ?? "Stop run"}
          type="button"
        >
          {props.stopLabel ? (
            <LoaderCircle
              aria-hidden="true"
              className="ohb-stop-pending"
              size={14}
            />
          ) : (
            <Square size={12} fill="currentColor" />
          )}
        </button>
      ) : (
        <button
          aria-busy={props.admitting}
          aria-label={props.sendLabel}
          className="ohb-send-button"
          disabled={!props.canSend}
          onClick={props.onSend}
          title={props.sendLabel}
          type="button"
        >
          {props.admitting ? (
            <LoaderCircle
              aria-hidden="true"
              className="ohb-send-spinner"
              size={14}
            />
          ) : (
            <ArrowUp size={15} />
          )}
        </button>
      )}
    </div>
  );
}
