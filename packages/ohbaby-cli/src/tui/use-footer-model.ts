import { useEffect, useState } from "react";
import type {
  CoreAPI,
  UiCurrentModelConfig,
  UiEventHandler,
  UiUnsubscribe,
} from "ohbaby-sdk";

/**
 * The model the chat's next turn uses: the session's own choice, else the
 * draft's `/models` choice, else the default. Independent of past usage.
 */
export function useFooterModel(
  client: CoreAPI,
  sessionId: string | null,
  subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe,
  draftEntryId: string | null = null,
): UiCurrentModelConfig | null {
  const [result, setResult] = useState<{
    client: CoreAPI;
    sessionId: string | null;
    draftEntryId: string | null;
    model: UiCurrentModelConfig | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      // Keep the last snapshot within this identity until its replacement is
      // known. The render guard below clears it immediately on session/client
      // changes, and the generation guard rejects obsolete replies.
      void client
        .getCurrentModel(
          sessionId
            ? { sessionId }
            : draftEntryId
              ? { modelEntryId: draftEntryId }
              : undefined,
        )
        .then(
          (model) => {
            if (active && request === generation)
              setResult({ client, sessionId, draftEntryId, model });
          },
          () => {
            if (active && request === generation) setResult(null);
          },
        );
    };
    const unsubscribe = subscribeEvents((event) => {
      if (
        event.type === "model.invalidated" ||
        (event.type === "session.updated" && event.session.id === sessionId)
      )
        refresh();
    });
    refresh();
    return (): void => {
      active = false;
      generation++;
      unsubscribe();
    };
  }, [client, sessionId, draftEntryId, subscribeEvents]);
  return result?.client === client &&
    result.sessionId === sessionId &&
    result.draftEntryId === draftEntryId
    ? result.model
    : null;
}
