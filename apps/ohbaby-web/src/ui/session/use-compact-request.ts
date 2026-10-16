import type { UiBackendClient, UiCompactSessionResult } from "ohbaby-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export interface CompactNotice {
  readonly sessionId: string;
  readonly text: string;
}

const NOTICE_MS = 4000;

/** Compaction outlives the overlay that starts it; the conversation shows its progress. */
export function useCompactRequest(
  client: Pick<UiBackendClient, "compactSession">,
  activeSessionId: string | undefined,
  onError: (error: string) => void,
): {
  readonly isCompacting: (sessionId: string | undefined) => boolean;
  readonly notice: CompactNotice | null;
  readonly start: (sessionId: string) => void;
} {
  const requests = useRef(new Map<string, AbortController>());
  const [, update] = useState(0);
  const [notice, setNotice] = useState<CompactNotice | null>(null);
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // A late failure belongs to the session that started it, not whichever is open now.
  const reportError = (sessionId: string, error: string): void => {
    if (activeRef.current === sessionId) onErrorRef.current(error);
  };

  useEffect(() => {
    const pending = requests.current;
    return (): void => {
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [client]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [notice]);

  const start = useCallback(
    (sessionId: string) => {
      if (requests.current.has(sessionId)) return;
      const controller = new AbortController();
      requests.current.set(sessionId, controller);
      setNotice(null);
      update((n) => n + 1);
      void client
        .compactSession({ sessionId, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          const failure = compactFailureMessage(result);
          if (failure) reportError(sessionId, failure);
          // A compacted result already lands as a durable conversation notice.
          else if (result.status === "not-needed")
            setNotice({ sessionId, text: "Nothing to compact" });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          reportError(
            sessionId,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          if (requests.current.get(sessionId) !== controller) return;
          requests.current.delete(sessionId);
          update((n) => n + 1);
        });
    },
    [client],
  );

  const isCompacting = useCallback(
    (sessionId: string | undefined) =>
      sessionId !== undefined && requests.current.has(sessionId),
    [],
  );

  return { isCompacting, notice, start };
}

export function compactFailureMessage(
  result: UiCompactSessionResult,
): string | null {
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
