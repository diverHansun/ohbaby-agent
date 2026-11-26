import {
  listRetriedAttemptIds,
  sameSessionGeneration,
  type UiMessage,
  type UiSessionHistory,
} from "ohbaby-sdk";
import { useLayoutEffect, useRef, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import type { StoreSnapshot } from "../../api/daemon/wire.js";

export interface SearchLocation {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly ticket: number;
  readonly selection: number;
}

interface Reading {
  readonly location: SearchLocation;
  readonly generation: number;
  readonly page?: UiSessionHistory;
  readonly status: "loading" | "ready" | "error" | "missing";
  readonly error?: string;
}

function contains(messages: readonly UiMessage[], id: string): boolean {
  return (
    messages.some((m) => m.id === id) &&
    !listRetriedAttemptIds(messages).has(id)
  );
}

function prependHistory(
  page: UiSessionHistory,
  previous?: UiSessionHistory,
): UiSessionHistory {
  const messages = [...page.messages, ...(previous?.messages ?? [])];
  const runs = new Map(
    [...page.runs, ...(previous?.runs ?? [])].map((run) => [run.id, run]),
  );
  const messageIds = new Set(messages.map((message) => message.id));
  const prompts = new Map(
    [...page.prompts, ...(previous?.prompts ?? [])]
      .filter(
        (prompt) =>
          messageIds.has(prompt.userMessageId) ||
          (prompt.runId && runs.has(prompt.runId)),
      )
      .map((prompt) => [prompt.promptId, prompt]),
  );
  return {
    ...page,
    messages,
    runs: [...runs.values()],
    prompts: [...prompts.values()],
  };
}

/** Owns one detached history window. Only the live synchronizer installs pages in the store. */
export interface SearchReading {
  current?: Reading;
  loadEarlier: () => Promise<boolean>;
  retry: () => void;
  dismiss: () => void;
}

export function useSearchLocation(
  runtime: OhbabyWebRuntime,
  location: SearchLocation | undefined,
  snapshot: StoreSnapshot,
  activeSessionId: string | undefined,
  follow: () => void,
  clearLocation?: () => void,
): SearchReading {
  const [reading, setReading] = useState<Reading>();
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController>(undefined);
  const last = useRef<Reading>(undefined);
  const loadingPage = useRef<AbortController>(undefined);
  const generation = snapshot.historyGeneration;
  const selection = runtime.getSelectionGeneration();
  const ready =
    snapshot.sessionSync.status === "ready" &&
    activeSessionId === location?.sessionId &&
    snapshot.sessionSync.view?.version.sessionId === location?.sessionId;
  const client = runtime.client;

  async function load(
    state: Reading,
    controller: AbortController,
    before?: string,
  ): Promise<boolean> {
    const { sessionId, messageId } = state.location;
    const current = (): boolean =>
      !controller.signal.aborted &&
      runtime.client === client &&
      runtime.getSelectionGeneration() === state.location.selection &&
      runtime.store.getSnapshot().historyGeneration === state.generation;
    try {
      const view = runtime.store.getSnapshot().sessionSync.view;
      if (!view || !client?.getSessionHistory)
        throw new Error("Message history is unavailable.");
      const page = await client.getSessionHistory({
        sessionId,
        runtimeEpoch: view.version.runtimeEpoch,
        bindingGeneration: view.bindingGeneration,
        ...(before ? { before } : { anchorMessageId: messageId }),
        limit: 50,
        signal: controller.signal,
      });
      if (!current()) return false;
      const latest = runtime.store.getSnapshot().sessionSync.view;
      if (
        !latest ||
        !sameSessionGeneration(page.version, latest.version) ||
        page.bindingGeneration !== latest.bindingGeneration
      ) {
        clearLocation?.();
        return false;
      }
      if (!before && (!messageId || !contains(page.messages, messageId))) {
        setReading({ ...state, status: "missing" });
        return false;
      }
      setReading({
        ...state,
        status: "ready",
        error: undefined,
        page: prependHistory(page, state.page),
      });
      return !page.hasMore || page.before !== before;
    } catch (error) {
      if (current())
        setReading({
          ...state,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      return false;
    }
  }

  useLayoutEffect(() => {
    last.current = reading;
  }, [reading]);

  useLayoutEffect(() => {
    const previous = last.current;
    if (location?.selection !== selection || !ready) {
      if (previous && previous.location === location) clearLocation?.();
      setReading(undefined);
      return;
    }
    if (previous?.location === location && previous.generation !== generation) {
      clearLocation?.();
      setReading(undefined);
      return;
    }
    if (!location.messageId) {
      follow();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const state: Reading = { location, generation, status: "ready" };
    const stored = runtime.store.getSnapshot();
    const live = stored.historyStale
      ? stored.sessionSync.view?.session
      : stored.view.snapshot?.sessions.find((s) => s.id === location.sessionId);
    if (contains(live?.messages ?? [], location.messageId)) setReading(state);
    else if (
      previous?.page &&
      previous.location.sessionId === location.sessionId &&
      previous.generation === generation &&
      contains(previous.page.messages, location.messageId)
    ) {
      setReading({ ...state, page: previous.page });
    } else {
      setReading({ ...state, status: "loading" });
      void load(state, controller);
    }
    return (): void => {
      controller.abort();
    };
  }, [
    runtime,
    client,
    location,
    ready,
    generation,
    selection,
    retry,
    clearLocation,
    follow,
  ]);

  const current =
    ready &&
    reading?.location === location &&
    reading?.generation === generation &&
    location?.selection === selection
      ? reading
      : undefined;
  const loadEarlier = async (): Promise<boolean> => {
    if (
      !current?.page?.before ||
      !request.current ||
      loadingPage.current === request.current ||
      current.status === "loading"
    )
      return false;
    setReading({ ...current, status: "loading", error: undefined });
    const controller = request.current;
    loadingPage.current = controller;
    try {
      return await load(current, controller, current.page.before);
    } finally {
      if (loadingPage.current === controller) loadingPage.current = undefined;
    }
  };
  return {
    current,
    loadEarlier,
    dismiss: (): void => {
      if (current?.page)
        setReading({ ...current, status: "ready", error: undefined });
      else clearLocation?.();
    },
    retry: (): void => {
      if (current?.page) void loadEarlier();
      else setRetry((count) => count + 1);
    },
  };
}
