import { useEffect, useState } from "react";
import type {
  CoreAPI,
  UiCurrentModelConfig,
  UiEventHandler,
  UiUnsubscribe,
} from "ohbaby-sdk";

/** Current configuration is independent of the model attached to past usage. */
export function useFooterModel(
  client: CoreAPI,
  sessionId: string | null,
  subscribeEvents: (handler: UiEventHandler) => UiUnsubscribe,
): UiCurrentModelConfig | null {
  const [result, setResult] = useState<{
    client: CoreAPI;
    sessionId: string | null;
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
      void client.getCurrentModel().then(
        (model) => {
          if (active && request === generation)
            setResult({ client, sessionId, model });
        },
        () => {
          if (active && request === generation) setResult(null);
        },
      );
    };
    const unsubscribe = subscribeEvents((event) => {
      if (event.type === "model.invalidated") refresh();
    });
    refresh();
    return (): void => {
      active = false;
      generation++;
      unsubscribe();
    };
  }, [client, sessionId, subscribeEvents]);
  return result?.client === client && result.sessionId === sessionId
    ? result.model
    : null;
}
