import type { LifecycleRunInputPort } from "../../core/lifecycle/types.js";
import type {
  CurrentRunInputRecord,
  CurrentRunInputStore,
} from "./current-run-inputs.js";

export interface RunInputSource {
  reconcile(signal?: AbortSignal): Promise<void>;
  confirmRequestSuccess?(
    inputs: readonly CurrentRunInputRecord[],
    requestId: string,
  ): Promise<void>;
}

/** Sources supply facts; only this port seals, closes, and acknowledges the shared inbox. */
export function createRunInputCoordinator(options: {
  readonly runId: string;
  readonly inputs: CurrentRunInputStore;
  readonly sources: readonly RunInputSource[];
}): LifecycleRunInputPort {
  const reconcile = async (signal?: AbortSignal): Promise<void> => {
    for (const source of options.sources) {
      signal?.throwIfAborted();
      await source.reconcile(signal);
    }
  };
  return {
    async beforeStep(
      signal,
      finalStep,
    ): ReturnType<LifecycleRunInputPort["beforeStep"]> {
      await reconcile(signal);
      if (finalStep) await options.inputs.sealSteer(options.runId);
      return options.inputs.getMessages(options.runId);
    },
    async beforeFinish(
      signal,
    ): ReturnType<LifecycleRunInputPort["beforeFinish"]> {
      await reconcile(signal);
      signal?.throwIfAborted();
      return (await options.inputs.tryCloseForCompletion(options.runId))
        ? "finish"
        : "continue";
    },
    admitRequestAttempt: (request, signal) =>
      options.inputs.admitRequestAttempt(request, signal),
    async confirmRequestSuccess(requestId): Promise<void> {
      const ids = await options.inputs.confirmRequestSuccess(requestId);
      const records: CurrentRunInputRecord[] = [];
      for (const id of ids) {
        const input = await options.inputs.getInput(id);
        if (input) records.push(input);
      }
      for (const source of options.sources)
        await source.confirmRequestSuccess?.(records, requestId);
    },
  };
}
