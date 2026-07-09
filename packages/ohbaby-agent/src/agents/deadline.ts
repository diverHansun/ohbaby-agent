export interface DeadlineController {
  readonly controller: AbortController;
  readonly dispose: () => void;
  readonly didTimeout: () => boolean;
  readonly parentAborted: Promise<void>;
  readonly signal: AbortSignal;
  readonly timedOut: Promise<void>;
}

export function createDeadlineController(input: {
  readonly parent?: AbortSignal;
  readonly reason: string;
  readonly timeoutMs: number;
}): DeadlineController {
  const controller = new AbortController();
  let timedOut = false;
  let resolveTimedOut!: () => void;
  let resolveParentAborted!: () => void;
  const timedOutPromise = new Promise<void>((resolve) => {
    resolveTimedOut = resolve;
  });
  const parentAbortedPromise = new Promise<void>((resolve) => {
    resolveParentAborted = resolve;
  });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) {
      return;
    }
    timedOut = true;
    controller.abort(input.reason);
    resolveTimedOut();
  }, input.timeoutMs);
  const abortFromParent = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(input.parent?.reason);
    }
    resolveParentAborted();
  };

  if (input.parent?.aborted) {
    abortFromParent();
  } else {
    input.parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    controller,
    didTimeout: (): boolean => timedOut,
    dispose: (): void => {
      clearTimeout(timeout);
      input.parent?.removeEventListener("abort", abortFromParent);
    },
    parentAborted: parentAbortedPromise,
    signal: controller.signal,
    timedOut: timedOutPromise,
  };
}
