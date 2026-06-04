import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";

export function startAppEventAdapter(
  _deps: DaemonEventAdapterDeps,
): DaemonEventAdapter {
  return {
    dispose(): void {
      return undefined;
    },
  };
}
