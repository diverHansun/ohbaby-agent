import type { UiBackendClient } from "ohbaby-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionFileEntry,
  SessionFilesApi,
} from "../../../api/daemon/session-files.js";

export interface SessionFilesState {
  /** Absent until the first list arrives; a failed refresh keeps the last one. */
  readonly files?: readonly SessionFileEntry[];
  readonly loading: boolean;
  readonly error?: string;
}

/** Run changes arrive in bursts (start, approvals, finish); one read covers them. */
const EVENT_SETTLE_MS = 400;

/**
 * The root session's scratch list while the Files page is mounted. It reads on
 * mount, on request, and after a run of the chat (or its subagents) changes,
 * since that is when the agent writes files. The daemon has no file events,
 * so nothing polls in between.
 */
export function useSessionFiles(
  api: SessionFilesApi,
  client: UiBackendClient,
  rootSessionId: string,
): SessionFilesState & { readonly refresh: () => void } {
  const [state, setState] = useState<SessionFilesState>({ loading: true });
  const current = useRef<AbortController | null>(null);
  const refresh = useCallback((): void => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    // A retry clears the old error, so its own Loading… or result shows.
    setState((previous) => ({ ...previous, loading: true, error: undefined }));
    api.list(rootSessionId, controller.signal).then(
      (files) => {
        if (controller.signal.aborted) return;
        setState({ files, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    );
  }, [api, rootSessionId]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribeEvents((event) => {
      const relevant =
        event.type === "run.updated" ||
        (event.type === "session.resync-required" && !event.disconnected);
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, EVENT_SETTLE_MS);
    });
    return (): void => {
      unsubscribe();
      clearTimeout(timer);
      current.current?.abort();
    };
  }, [client, refresh]);

  return { ...state, refresh };
}
