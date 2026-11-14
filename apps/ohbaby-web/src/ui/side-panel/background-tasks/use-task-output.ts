import type { UiBackendClient, UiShellJobOutput } from "ohbaby-sdk";
import { useCallback, useEffect, useState } from "react";
import { TASK_REFRESH_INTERVAL_MS } from "../../shared/background-tasks.js";

export interface TaskOutputState {
  readonly output?: UiShellJobOutput;
  /** The last read failed; polling waits for `retry`. */
  readonly error?: string;
  /** The task left this chat's tree. */
  readonly notFound: boolean;
  readonly loading: boolean;
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * One task's output tail (06 §3.3). While the task runs and the page is
 * visible it is read every two seconds, each read starting after the last
 * answered; an ended task is read once more and then left alone.
 */
export function useTaskOutput(
  client: UiBackendClient,
  rootSessionId: string,
  jobId: string,
  enabled = true,
): TaskOutputState & { readonly retry: () => void } {
  const [state, setState] = useState<TaskOutputState>({
    notFound: false,
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingForVisible = false;
    const read = async (): Promise<void> => {
      timer = undefined;
      if (document.visibilityState !== "visible") {
        waitingForVisible = true;
        return;
      }
      if (!client.getShellJobOutput) {
        setState({
          notFound: false,
          loading: false,
          error: "Background tasks are unavailable",
        });
        return;
      }
      try {
        const output = await client.getShellJobOutput({
          rootSessionId,
          jobId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState({ output, notFound: false, loading: false });
        // Terminal status can arrive before the final output has been drained.
        if (
          output.job.status === "running" ||
          output.job.resultReadyAt === null
        )
          schedule();
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = errorCode(error);
        if (code === "SHELL_JOB_NOT_FOUND")
          setState({ notFound: true, loading: false });
        else if (
          code === "SHELL_JOB_NOT_READY" ||
          code === "SESSION_SCOPE_CHANGED"
        )
          schedule();
        else
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    };
    const schedule = (): void => {
      if (controller.signal.aborted) return;
      if (document.visibilityState !== "visible") {
        waitingForVisible = true;
        return;
      }
      timer = setTimeout(() => {
        void read();
      }, TASK_REFRESH_INTERVAL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible" || !waitingForVisible) return;
      waitingForVisible = false;
      void read();
    };
    const unsubscribe = client.subscribeEvents((event) => {
      if (
        event.type === "session.resync-required" &&
        !event.disconnected &&
        (event.sessionId === null || event.sessionId === rootSessionId) &&
        timer !== undefined
      ) {
        clearTimeout(timer);
        void read();
      }
    });
    setState((current) => ({ ...current, error: undefined }));
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return (): void => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, rootSessionId, jobId, attempt, enabled]);
  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);
  return { ...state, retry };
}
