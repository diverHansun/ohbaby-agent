import type {
  UiBackendClient,
  UiCompactSessionResult,
  UiContextWindowUsage,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatTokenCount,
  type OverlayStatus,
  OverlayStatusLine,
} from "./overlay-controls.js";

export function CompactOverlayBody(props: {
  readonly client: Pick<
    UiBackendClient,
    "getContextWindowUsage" | "compactSession"
  >;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly sessionId: string | undefined;
}): ReactElement {
  const { onBusyChange, sessionId } = props;
  const pending = useRef<AbortController | null>(null);
  const [usage, setUsage] = useState<UiContextWindowUsage | null>(null);
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId ? "" : "No active session to compact.",
  });

  useEffect(() => {
    setUsage(null);
    setStatus({
      kind: "idle",
      message: sessionId ? "" : "No active session to compact.",
    });
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
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    };
  }, [props.client, sessionId]);

  const busy = status.kind === "busy";
  useEffect(() => {
    if (!busy) return;
    onBusyChange?.(true);
    return (): void => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const compactSession = useCallback(() => {
    if (pending.current) return;
    if (!sessionId) {
      setStatus({ kind: "error", message: "No active session to compact." });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setStatus({ kind: "busy", message: "Compacting session…" });
    void (async (): Promise<void> => {
      try {
        const nextResult = await props.client.compactSession({
          sessionId,
          signal: controller.signal,
        });
        if (pending.current !== controller) return;
        const nextUsage = await props.client
          .getContextWindowUsage({ sessionId })
          .catch(() => usageFromCompactResult(nextResult));
        if (pending.current !== controller) return;
        setUsage(nextUsage);
        const failureMessage = compactFailureMessage(nextResult);
        if (failureMessage) {
          throw new Error(failureMessage);
        }
        // A returned result is authoritative even when Stop raced its commit.
        setStatus({
          kind: "success",
          message:
            nextResult.status === "not-needed"
              ? "Nothing to compact"
              : // Same full-window estimate as the durable conversation notice.
                `Compacted · ${formatTokenCount(nextResult.usageBefore.currentTokens)} → ${formatTokenCount(nextResult.usageAfter.currentTokens)} tokens`,
        });
      } catch (error) {
        if (pending.current !== controller) return;
        if (
          (error instanceof Error || error instanceof DOMException) &&
          error.name === "AbortError"
        ) {
          // Aborting transport cannot undo a commit whose response is still in flight.
          const latest = await props.client
            .getContextWindowUsage({ sessionId })
            .catch(() => null);
          if (pending.current !== controller) return;
          setUsage(latest);
          // An AbortError alone cannot tell whether the server committed first.
          setStatus({
            kind: "idle",
            message:
              "Stopped waiting. If compaction had already finished, its result stays in the conversation.",
          });
        } else
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    })();
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
          className="ohb-button-primary"
          disabled={!sessionId || status.kind === "busy"}
          onClick={compactSession}
          title="Compact session"
          type="button"
        >
          {status.kind === "busy" ? "Compacting…" : "Compact session"}
        </button>
        {status.kind === "busy" ? (
          <button
            className="ohb-button"
            disabled={pending.current?.signal.aborted === true}
            onClick={() => {
              pending.current?.abort();
              setStatus({ kind: "busy", message: "Stopping compaction…" });
            }}
            title="Stop compaction"
            type="button"
          >
            Stop
          </button>
        ) : null}
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
        <span>model</span>
        <strong>{usage.modelId}</strong>
      </div>
      <div className="ohb-compact-usage">
        <span>context</span>
        <strong>
          {formatTokenCount(usage.currentTokens)} /{" "}
          {formatTokenCount(usage.contextWindowTokens)}
          <em>{`${String(Math.round(usage.contextWindowRatio * 100))}%`}</em>
        </strong>
        <i
          aria-hidden="true"
          className={ratio >= 0.9 ? "is-high" : undefined}
          style={{ width: `${String(ratio * 100)}%` }}
        />
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
  const label =
    result.status === "failed"
      ? "Compaction failed"
      : "Compaction did not reduce context";
  return error ? `${label}: ${error}` : label;
}
