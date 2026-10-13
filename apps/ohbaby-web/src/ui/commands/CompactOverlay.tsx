import type {
  UiBackendClient,
  UiCompactSessionResult,
  UiContextWindowUsage,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  formatTokenCount,
  OverlayResult,
  type OverlayStatus,
  OverlayStatusLine,
  runOverlayAction,
} from "./overlay-controls.js";

export function CompactOverlayBody(props: {
  readonly client: Pick<
    UiBackendClient,
    "getContextWindowUsage" | "compactSession"
  >;
  readonly sessionId: string | undefined;
}): ReactElement {
  const { sessionId } = props;
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
          sessionId,
        });
        setResult(nextResult);
        setUsage(
          await props.client
            .getContextWindowUsage({ sessionId })
            .catch(() => usageFromCompactResult(nextResult)),
        );
        const failureMessage = compactFailureMessage(nextResult);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        return `compact ${nextResult.status}`;
      },
      "Compacting session",
    );
  }, [props.client, sessionId]);

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
          ]}
        />
      ) : null}
      <div className="ohb-structured-actions">
        <button
          className="ohb-button-primary"
          disabled={!sessionId || status.kind === "busy"}
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

// The compact result is authoritative; a failed refresh falls back to its estimate.
function usageFromCompactResult(
  result: UiCompactSessionResult,
): UiContextWindowUsage | null {
  const { contextLimit, currentTokens, modelId } = result.usageAfter;
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) return null;
  return {
    contextWindowRatio: currentTokens / contextLimit,
    contextWindowTokens: contextLimit,
    currentTokens,
    estimatedAt: new Date().toISOString(),
    modelId,
    sessionId: result.sessionId,
  };
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
