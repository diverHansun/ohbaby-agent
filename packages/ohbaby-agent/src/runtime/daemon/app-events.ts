import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";
import {
  subscribeAppEventProjectors,
  toAppStreamEvent,
} from "../../adapters/app-events/index.js";

export function startAppEventAdapter(
  { bus, streamBridge }: DaemonEventAdapterDeps,
): DaemonEventAdapter {
  const unsubscribe = subscribeAppEventProjectors({
    bus,
    target: (projected) => {
      const event = toAppStreamEvent(projected);
      streamBridge.publish("app", event.type, event.data);
    },
  });

  return {
    dispose(): void {
      unsubscribe();
    },
  };
}
