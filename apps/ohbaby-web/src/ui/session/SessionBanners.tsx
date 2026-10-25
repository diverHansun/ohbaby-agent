import type { ReactElement } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { Banner } from "../shared/Banner.js";
import { readableError } from "../shared/error-text.js";
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
  return props.state === "recovering" ? (
    <Banner
      tone="info"
      message="Recovering conversation… Your draft remains editable."
    />
  ) : (
    <Banner
      tone="error"
      message={`Conversation unavailable: ${readableError(props.error ?? "Recovery failed")}`}
      actions={[{ label: "Retry conversation", onClick: props.onRetry }]}
    />
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
        <Banner
          tone="attention"
          message={
            promptRecoveryReminders.some(
              (request) => request.status === "epoch-changed",
            )
              ? "The backend restarted. A previous submission could not be confirmed; check its original conversation before sending again."
              : "Submission result is unknown. Check its receipt before sending again."
          }
          actions={[
            {
              label: "Check submission",
              onClick: () => {
                void runtime.retryUnknownPrompts();
              },
            },
            ...promptRecoveryReminders.map((request) => ({
              label: "Forget pending submission",
              disabled: request.submitting,
              title:
                "Remove this local reminder. The original submission may still have run; this does not cancel or resend it.",
              onClick: () => {
                runtime.forgetUnknownPrompt(request.clientRequestId);
              },
            })),
          ]}
        />
      ) : null}
      <Banner
        tone="info"
        message={
          props.reasoningMissing
            ? "Some thinking could not be saved and is no longer available."
            : null
        }
      />
    </>
  );
}
