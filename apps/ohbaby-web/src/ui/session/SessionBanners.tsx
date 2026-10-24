import type { ReactElement } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import type { SessionSyncBanner } from "./use-session-sync-banner.js";

/** Loading and recovery state of the open conversation; silent when it is healthy. */
export function SessionSyncNotice(props: {
  readonly state: SessionSyncBanner;
  readonly error?: string;
  readonly onRetry: () => void;
}): ReactElement | null {
  if (!props.state) return null;
  if (props.state === "loading")
    return (
      <div
        className="ohb-conversation-loading"
        role="status"
        aria-live="polite"
      >
        Loading conversation…
      </div>
    );
  return (
    <div
      className="ohb-error-banner"
      role={props.state === "error" ? "alert" : "status"}
    >
      <span>
        {props.state === "recovering"
          ? "Recovering conversation… Your draft remains editable."
          : `Conversation unavailable: ${props.error ?? "Recovery failed"}`}
      </span>
      {props.state === "error" ? (
        <button type="button" onClick={props.onRetry}>
          Retry conversation
        </button>
      ) : null}
    </div>
  );
}

/** Banners that only appear when something needs the user's attention. */
export function SessionBanners(props: {
  readonly runtime: OhbabyWebRuntime;
  readonly promptRecoveryReminders: ReturnType<
    OhbabyWebRuntime["store"]["getSnapshot"]
  >["unknownPromptRequests"];
  readonly reasoningMissing: boolean;
}): ReactElement {
  const { runtime, promptRecoveryReminders } = props;
  return (
    <>
      {promptRecoveryReminders.length > 0 ? (
        <div className="ohb-error-banner" role="status">
          <span>
            {promptRecoveryReminders.some(
              (request) => request.status === "epoch-changed",
            )
              ? "The backend restarted. A previous submission could not be confirmed; check its original conversation before sending again."
              : "Submission result is unknown. Check its receipt before sending again."}
          </span>
          <button
            type="button"
            onClick={() => {
              void runtime.retryUnknownPrompts();
            }}
          >
            Check submission
          </button>
          {promptRecoveryReminders.map((request) => (
            <button
              key={request.clientRequestId}
              type="button"
              disabled={request.submitting}
              title="Remove this local reminder. The original submission may still have run; this does not cancel or resend it."
              onClick={() => {
                runtime.forgetUnknownPrompt(request.clientRequestId);
              }}
            >
              Forget pending submission
            </button>
          ))}
        </div>
      ) : null}
      {props.reasoningMissing ? (
        <div className="ohb-error-banner" role="status">
          Some thinking could not be saved and is no longer available.
        </div>
      ) : null}
    </>
  );
}
