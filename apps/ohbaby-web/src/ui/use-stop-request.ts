import { useEffect, useRef, useState } from "react";
import type { UiSnapshot } from "ohbaby-sdk";
import type { OhbabyWebRuntime } from "../api/daemon/client.js";

interface StopRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: number;
  confirmed: boolean;
  transportError?: string;
  failureSnapshot?: UiSnapshot | null;
}
function isTerminal(
  snapshot: UiSnapshot | null,
  request: StopRequest,
): boolean {
  const prompt = snapshot?.prompts?.find(
    (p) => p.sessionId === request.sessionId && p.runId === request.runId,
  );
  if (prompt)
    return (
      prompt.endedAt !== undefined &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        prompt.status,
      )
    );
  const run = snapshot?.runs.find(
    (r) => r.sessionId === request.sessionId && r.id === request.runId,
  );
  return (
    run !== undefined &&
    run.status.kind !== "running" &&
    run.status.kind !== "waiting-for-permission"
  );
}

/** RPC acceptance and authoritative completion deliberately have separate lifetimes. */
export function useStopRequest(
  runtime: OhbabyWebRuntime,
  sessionId: string | undefined,
  runId: string | undefined,
  onError: (error: string) => void,
): { readonly label?: string; readonly stop: () => void } {
  const requests = useRef(new Map<string, StopRequest>());
  const latestRuns = useRef(new Map<string, string>());
  if (sessionId && runId) latestRuns.current.set(sessionId, runId);
  const [, update] = useState(0);
  useEffect(() => {
    requests.current.clear();
    latestRuns.current.clear();
    if (sessionId && runId) latestRuns.current.set(sessionId, runId);
    return runtime.store.subscribe(() => {
      const state = runtime.store.getSnapshot();
      for (const [key, request] of requests.current) {
        if (isTerminal(state.view.snapshot, request)) {
          request.confirmed = true;
          requests.current.delete(key);
          update((n) => n + 1);
        } else if (
          request.transportError &&
          state.connectionState === "live" &&
          state.sessionSync.status === "ready" &&
          state.view.snapshot !== request.failureSnapshot &&
          state.view.snapshot?.activeSessionId === request.sessionId
        ) {
          requests.current.delete(key);
          if (latestRuns.current.get(request.sessionId) === request.runId)
            onError(request.transportError);
          update((n) => n + 1);
        }
      }
    });
  }, [runtime, runtime.client]);
  const request =
    sessionId === undefined
      ? undefined
      : [...requests.current.values()].find(
          (r) =>
            r.sessionId === sessionId &&
            r.runId === (runId ?? latestRuns.current.get(sessionId)),
        );
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(
      () => {
        update((n) => n + 1);
      },
      Math.max(0, 10000 - (performance.now() - request.startedAt)),
    );
    return (): void => {
      clearTimeout(timer);
    };
  }, [request]);
  const disconnected = runtime.store.getSnapshot().connectionState !== "live";
  return {
    label: request
      ? disconnected
        ? "Stopping run · connection unavailable, status unconfirmed"
        : performance.now() - request.startedAt >= 10000
          ? "Still stopping run"
          : "Stopping run"
      : undefined,
    stop: (): void => {
      if (!sessionId || !runId) return;
      const key = JSON.stringify([sessionId, runId]);
      if (requests.current.has(key)) return;
      const pending: StopRequest = {
        sessionId,
        runId,
        startedAt: performance.now(),
        confirmed: false,
      };
      requests.current.set(key, pending);
      update((n) => n + 1);
      void runtime.abortSession(sessionId, runId).catch((error: unknown) => {
        if (pending.confirmed || requests.current.get(key) !== pending) return;
        if (isTerminal(runtime.store.getSnapshot().view.snapshot, pending)) {
          pending.confirmed = true;
          requests.current.delete(key);
        } else if (runtime.store.getSnapshot().connectionState === "live") {
          requests.current.delete(key);
          // An old session's error must not replace the active session's controls.
          if (
            runtime.store.getSnapshot().view.snapshot?.activeSessionId ===
              sessionId &&
            latestRuns.current.get(sessionId) === runId
          )
            onError(error instanceof Error ? error.message : String(error));
        } else {
          pending.transportError =
            error instanceof Error ? error.message : String(error);
          pending.failureSnapshot = runtime.store.getSnapshot().view.snapshot;
        }
        update((n) => n + 1);
      });
    },
  };
}
