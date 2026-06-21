import {
  createInitialViewState,
  reduceUiEvent,
  replaceSnapshot,
} from "../api/daemon/eventReducer.js";
import type { ConnectionState, StoreSnapshot } from "../api/daemon/wire.js";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";

export type StoreListener = () => void;

export interface OhbabyWebStore {
  applyEvent(event: UiEvent, seqNum: number): void;
  getSnapshot(): StoreSnapshot;
  replaceSnapshot(snapshot: UiSnapshot, seqNum: number): void;
  setConnectionState(state: ConnectionState): void;
  setError(error: string | null): void;
  subscribe(listener: StoreListener): () => void;
}

export function createOhbabyWebStore(): OhbabyWebStore {
  let snapshot: StoreSnapshot = {
    connectionState: "connecting",
    error: null,
    view: createInitialViewState(),
  };
  const listeners = new Set<StoreListener>();

  function publish(next: StoreSnapshot): void {
    snapshot = next;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }

  return {
    applyEvent(event, seqNum): void {
      const nextView = reduceUiEvent(snapshot.view, event, seqNum);
      if (nextView === snapshot.view) {
        return;
      }
      publish({
        ...snapshot,
        view: nextView,
      });
    },
    getSnapshot(): StoreSnapshot {
      return snapshot;
    },
    replaceSnapshot(nextSnapshot, seqNum): void {
      publish({
        ...snapshot,
        view: replaceSnapshot(nextSnapshot, seqNum),
      });
    },
    setConnectionState(state): void {
      if (snapshot.connectionState === state) {
        return;
      }
      publish({ ...snapshot, connectionState: state });
    },
    setError(error): void {
      if (snapshot.error === error) {
        return;
      }
      publish({ ...snapshot, error });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
