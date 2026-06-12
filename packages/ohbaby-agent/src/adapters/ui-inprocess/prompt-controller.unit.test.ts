import type { SubmitPromptOptions } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { PromptQueueClosedError } from "../ui-prompt-queue.js";
import { InProcessPromptController } from "./prompt-controller.js";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("InProcessPromptController", () => {
  it("runs the first prompt immediately", async (): Promise<void> => {
    const calls: {
      readonly options?: SubmitPromptOptions;
      readonly text: string;
    }[] = [];
    const controller = new InProcessPromptController({
      isBusyError: (): boolean => false,
      readActiveSessionId: (): Promise<string | null> => Promise.resolve(null),
      retryDelayMs: 0,
      submitPromptInternal(text, options): Promise<void> {
        calls.push({ options, text });
        return Promise.resolve();
      },
    });

    await controller.submitPrompt("first");

    expect(calls).toEqual([{ text: "first" }]);
  });

  it("makes a queued prompt inherit the active session when it drains", async (): Promise<void> => {
    const first = deferred();
    let activeSessionId: string | null = null;
    const calls: {
      readonly options?: SubmitPromptOptions;
      readonly text: string;
    }[] = [];
    const controller = new InProcessPromptController({
      isBusyError: (): boolean => false,
      readActiveSessionId: (): Promise<string | null> =>
        Promise.resolve(activeSessionId),
      retryDelayMs: 0,
      async submitPromptInternal(text, options): Promise<void> {
        calls.push({ options, text });
        if (text === "first") {
          activeSessionId = "session_started";
          await first.promise;
        }
      },
    });

    const firstDone = controller.submitPrompt("first");
    await vi.waitUntil(() => calls.length === 1);
    const secondDone = controller.submitPrompt("second");

    first.resolve(undefined);
    await Promise.all([firstDone, secondDone]);

    expect(calls).toEqual([
      { text: "first" },
      { options: { sessionId: "session_started" }, text: "second" },
    ]);
  });

  it("does not inherit a session for sequential prompts submitted after the queue is idle", async (): Promise<void> => {
    const calls: {
      readonly options?: SubmitPromptOptions;
      readonly text: string;
    }[] = [];
    const readActiveSessionId = vi.fn<() => Promise<string | null>>(() =>
      Promise.resolve("session_previous"),
    );
    const controller = new InProcessPromptController({
      isBusyError: (): boolean => false,
      readActiveSessionId,
      retryDelayMs: 0,
      submitPromptInternal(text, options): Promise<void> {
        calls.push({ options, text });
        return Promise.resolve();
      },
    });

    await controller.submitPrompt("first");
    await controller.submitPrompt("second");

    expect(readActiveSessionId).not.toHaveBeenCalled();
    expect(calls).toEqual([{ text: "first" }, { text: "second" }]);
  });

  it("rejects pending queued prompts when closed", async (): Promise<void> => {
    const first = deferred();
    const controller = new InProcessPromptController({
      isBusyError: (): boolean => false,
      readActiveSessionId: (): Promise<string | null> => Promise.resolve(null),
      retryDelayMs: 0,
      async submitPromptInternal(text): Promise<void> {
        if (text === "first") {
          await first.promise;
        }
      },
    });

    const firstDone = controller.submitPrompt("first");
    await vi.waitUntil(() => controller.hasPendingWork());
    const secondDone = controller.submitPrompt("second");
    await vi.waitUntil(() => controller.queuedCount() === 1);

    controller.close();
    first.resolve(undefined);

    await expect(firstDone).resolves.toBeUndefined();
    await expect(secondDone).rejects.toBeInstanceOf(PromptQueueClosedError);
  });
});
