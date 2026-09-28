import type { ShutdownOptions } from "ohbaby-agent";
import type { CliCoreHost } from "./commands/types.js";

interface SignalSource {
  on(signal: string, handler: () => void): unknown;
  off(signal: string, handler: () => void): unknown;
}

/** Owns terminal/process signals only; an interactive Ctrl-C remains the UI's Stop command. */
export function createCliHostShutdown(
  host: Pick<CliCoreHost, "closeAdmission" | "dispose">,
  onSignal?: () => void,
  signals: SignalSource = process,
): { readonly interrupted: Promise<void>; dispose(): Promise<void> } {
  let options: ShutdownOptions | undefined;
  let disposePromise: Promise<void> | undefined;
  let resolveInterrupted!: () => void;
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const begin = (): ShutdownOptions => {
    if (!options) {
      options = {
        deadlineAt: Date.now() + 10_000,
        signal: AbortSignal.timeout(10_000),
      };
      host.closeAdmission?.();
    }
    return options;
  };
  const signalNames =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handleSignal = (): void => {
    begin();
    onSignal?.();
    resolveInterrupted();
  };
  for (const name of signalNames) signals.on(name, handleSignal);
  return {
    interrupted,
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      const sharedOptions = begin();
      disposePromise = Promise.resolve()
        .then(() => host.dispose(sharedOptions))
        .finally(() => {
          for (const name of signalNames) signals.off(name, handleSignal);
        });
      return disposePromise;
    },
  };
}
