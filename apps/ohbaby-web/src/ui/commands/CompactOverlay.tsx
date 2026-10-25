import type { UiBackendClient, UiContextWindowUsage } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import {
  formatTokenCount,
  type OverlayStatus,
  OverlayStatusLine,
} from "./overlay-controls.js";

const IDLE_STATUS: OverlayStatus = { kind: "idle", message: "" };

export function CompactOverlayBody(props: {
  readonly client: Pick<UiBackendClient, "getContextWindowUsage">;
  readonly compacting: boolean;
  readonly onCompact: (sessionId: string) => void;
  readonly sessionId: string | undefined;
}): ReactElement {
  const { sessionId } = props;
  const [usage, setUsage] = useState<UiContextWindowUsage | null>(null);
  const [status, setStatus] = useState<OverlayStatus>(IDLE_STATUS);

  useEffect(() => {
    setUsage(null);
    setStatus(IDLE_STATUS);
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    void props.client
      .getContextWindowUsage({ sessionId })
      .then((nextUsage) => {
        if (!cancelled) {
          setUsage(nextUsage);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [props.client, sessionId]);

  return (
    <div className="ohb-structured-body">
      <p>
        {sessionId
          ? "Summarize older history to free up context. Token counts are local estimates."
          : "Open a session before compacting context."}
      </p>
      {usage ? <ContextUsageCard usage={usage} /> : null}
      <OverlayStatusLine status={status} />
      <div className="ohb-structured-actions">
        <button
          // `/compact` then Enter, Enter again runs it; a disabled button
          // stays unfocused, so the dialog falls back to the close button.
          autoFocus
          className="ohb-button-primary"
          disabled={!sessionId || props.compacting}
          onClick={() => {
            // Progress and the result belong to the conversation, not this overlay.
            if (sessionId) props.onCompact(sessionId);
          }}
          title="Compact session"
          type="button"
        >
          {props.compacting ? "Compacting…" : "Compact session"}
        </button>
      </div>
    </div>
  );
}

function ContextUsageCard(props: {
  readonly usage: UiContextWindowUsage;
}): ReactElement {
  const { usage } = props;
  const ratio = Math.min(1, Math.max(0, usage.contextWindowRatio));
  return (
    <div className="ohb-structured-result">
      <div>
        <span>Model</span>
        <strong>{usage.modelId}</strong>
      </div>
      <div className="ohb-compact-usage">
        <span>Context</span>
        <div>
          <strong>
            {formatTokenCount(usage.currentTokens)} /{" "}
            {formatTokenCount(usage.contextWindowTokens)}
            <em>{`${String(Math.round(usage.contextWindowRatio * 100))}%`}</em>
          </strong>
          <b aria-hidden="true">
            <i
              className={ratio >= 0.9 ? "is-high" : undefined}
              style={{ width: `${String(ratio * 100)}%` }}
            />
          </b>
        </div>
      </div>
    </div>
  );
}
