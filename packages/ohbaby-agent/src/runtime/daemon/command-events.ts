import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";

export function startCommandEventAdapter({
  bus,
  streamBridge,
  eventDefinitions = [],
}: DaemonEventAdapterDeps): DaemonEventAdapter {
  const unsubscribers = eventDefinitions.map((eventDefinition) =>
    bus.subscribe(eventDefinition, (payload) => {
      streamBridge.publish("app", eventDefinition.type, payload);
    }),
  );

  return {
    dispose(): void {
      for (const unsubscribe of unsubscribers.splice(0)) {
        unsubscribe();
      }
    },
  };
}
