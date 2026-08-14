import type { UiEvent } from "ohbaby-sdk";

export const STREAMING_UI_FLUSH_MS = 50;

export interface CoalescedTuiEventDispatcher {
  readonly dispatch: (event: UiEvent) => void;
  readonly dispose: () => void;
}

export function createCoalescedTuiEventDispatcher(
  dispatchBatch: (events: readonly UiEvent[]) => void,
  options: { readonly flushMs?: number } = {},
): CoalescedTuiEventDispatcher {
  const flushMs = options.flushMs ?? STREAMING_UI_FLUSH_MS;
  const pendingDeltas = new Map<
    string,
    Extract<UiEvent, { type: "message.part.delta" }>
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = (): readonly UiEvent[] => {
    clearTimer();
    if (pendingDeltas.size === 0) {
      return [];
    }
    const events = Array.from(pendingDeltas.values());
    pendingDeltas.clear();
    dispatchBatch(events);
    return events;
  };

  const scheduleFlush = (): void => {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      flush();
    }, flushMs);
  };

  return {
    dispatch(event): void {
      if (event.type !== "message.part.delta") {
        clearTimer();
        if (pendingDeltas.size === 0) {
          dispatchBatch([event]);
          return;
        }

        const deltas = Array.from(pendingDeltas.values());
        pendingDeltas.clear();
        dispatchBatch([...deltas, event]);
        return;
      }

      const key = deltaKey(event);
      const previous = pendingDeltas.get(key);
      pendingDeltas.set(key, previous ? mergeDelta(previous, event) : event);
      scheduleFlush();
    },
    dispose(): void {
      flush();
    },
  };
}

function deltaKey(
  event: Extract<UiEvent, { type: "message.part.delta" }>,
): string {
  return [event.sessionId, event.messageId, event.partId ?? ""].join("\u0000");
}

function mergeDelta(
  previous: Extract<UiEvent, { type: "message.part.delta" }>,
  next: Extract<UiEvent, { type: "message.part.delta" }>,
): Extract<UiEvent, { type: "message.part.delta" }> {
  return {
    ...next,
    content:
      next.content ??
      (previous.content === undefined
        ? undefined
        : `${previous.content}${next.delta}`),
    delta: `${previous.delta}${next.delta}`,
  };
}
