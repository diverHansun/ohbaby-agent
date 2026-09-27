import type {
  UiBackendClient,
  UiCompactSessionResult,
  UiContextWindowUsage,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { type ViewModel } from "../session/selectors.js";
import { formatTokenCount } from "./GoalControl.js";
import {
  OverlayResult,
  type OverlayStatus,
  OverlayStatusLine,
  runOverlayAction,
} from "./overlay-controls.js";

export function CompactOverlayBody(props: {
  readonly client: UiBackendClient;
  readonly view: ViewModel;
}): ReactElement {
  const sessionId =
    props.view.composer.activeSessionId ?? props.view.activeSession?.id;
  const [force, setForce] = useState(true);
  const [usage, setUsage] = useState<UiContextWindowUsage | null>(null);
  const [result, setResult] = useState<UiCompactSessionResult | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId ? "" : "No active session to compact.",
  });

  useEffect(() => {
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

  const compactSession = useCallback(() => {
    if (!sessionId) {
      setStatus({ kind: "error", message: "No active session to compact." });
      return;
    }
    void runOverlayAction(
      setStatus,
      async () => {
        const nextResult = await props.client.compactSession({
          force,
          sessionId,
        });
        setResult(nextResult);
        const failureMessage = compactFailureMessage(nextResult);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        return `compact ${nextResult.status}`;
      },
      "Compacting session",
    );
  }, [force, props.client, sessionId]);

  return (
    <div className="ohb-structured-body">
      <p>
        {sessionId
          ? `Compact current session ${sessionId}.`
          : "Open a session before compacting context."}
      </p>
      {usage ? (
        <OverlayResult
          rows={[
            ["model", usage.modelId],
            ["current", formatTokenCount(usage.currentTokens)],
            ["limit", formatTokenCount(usage.contextWindowTokens)],
            ["ratio", `${String(Math.round(usage.contextWindowRatio * 100))}%`],
          ]}
        />
      ) : null}
      <label className="ohb-structured-check">
        <input
          checked={force}
          onChange={(event) => {
            setForce(event.target.checked);
          }}
          type="checkbox"
        />
        force compaction
      </label>
      <OverlayStatusLine status={status} />
      {result ? (
        <OverlayResult
          rows={[
            ["status", result.status],
            ["before", formatTokenCount(result.usageBefore.currentTokens)],
            ["after", formatTokenCount(result.usageAfter.currentTokens)],
            [
              "saved",
              result.compression
                ? formatTokenCount(result.compression.savedTokens)
                : "none",
            ],
            [
              "pruned",
              result.prune ? String(result.prune.prunedCount) : "none",
            ],
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button-primary"
          disabled={!sessionId}
          onClick={compactSession}
          title="Compact session"
          type="button"
        >
          Compact session
        </button>
      </div>
    </div>
  );
}

function compactFailureMessage(result: UiCompactSessionResult): string | null {
  if (result.status !== "failed" && result.status !== "inflated") {
    return null;
  }
  const error = result.error ?? result.compression?.error;
  return error
    ? `compact ${result.status}: ${error}`
    : `compact ${result.status}`;
}
