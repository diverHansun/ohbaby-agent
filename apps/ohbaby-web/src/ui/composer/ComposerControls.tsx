import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import type {
  UiPermissionLevel,
  UiReasoningConfig,
  UiSession,
  UiSettingsModel,
} from "ohbaby-sdk";
import type { ReactElement, ReactNode } from "react";
import { ComposerMoreMenu } from "./ComposerMoreMenu.js";
import {
  useReasoning,
  type ReasoningClient,
  type ReasoningState,
} from "./useReasoning.js";

/**
 * Bottom row inside the composer card: permission control on the left; the
 * model button (which also carries Reasoning Effort, D37) and the round send
 * (or Stop) button on the right (D22). Below 640px CSS swaps the permission
 * control for one More menu (D29).
 */
export function ComposerControls(props: {
  readonly client: ReasoningClient;
  readonly session: UiSession | null;
  /** The settings entry this chat's next turn uses, once the list loads. */
  readonly modelEntry?: UiSettingsModel;
  readonly permissionControl: ReactNode;
  readonly permission: {
    readonly level: UiPermissionLevel;
    readonly disabled: boolean;
    readonly onSet: (input: { readonly level: UiPermissionLevel }) => void;
  };
  /** The model menu, given this chat's Reasoning Effort; absent while no settings are reachable. */
  readonly modelControl?: (reasoning: ReasoningState) => ReactNode;
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
  const reasoning = useReasoning(
    props.client,
    props.session,
    props.onReasoningChange,
    props.modelEntry,
  );
  return (
    <div className="ohb-composer-bar">
      <ComposerMoreMenu
        permissionLevel={props.permission.level}
        permissionDisabled={props.permission.disabled}
        onSetPermission={props.permission.onSet}
      />
      {props.permissionControl}
      <div className="ohb-composer-bar-spacer" />
      {props.modelControl?.(reasoning)}
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
            <Square size={10} fill="currentColor" />
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
