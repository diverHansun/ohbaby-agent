import { describe, expect, it, vi } from "vitest";
import {
  PromptQueueClosedError,
  PromptQueueController,
} from "./ui-prompt-queue.js";
import type { PromptQueueItem } from "./ui-prompt-queue.js";

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

describe("PromptQueueController", () => {
  it("drains prompts in insertion order", async () => {
    const first = deferred();
    const calls: string[] = [];
    const queue = new PromptQueueController({
      isBusyError: (): boolean => false,
      retryDelayMs: 0,
      async submit(item): Promise<void> {
        calls.push(item.text);
        if (item.text === "first") {
          await first.promise;
        }
      },
    });

    const firstDone = queue.enqueue({ sessionId: "session_1", text: "first" });
    const secondDone = queue.enqueue({
      sessionId: "session_1",
      text: "second",
    });
    await vi.waitUntil(() => calls.length === 1);

    expect(calls).toEqual(["first"]);
    expect(queue.size()).toBe(1);

    first.resolve(undefined);
    await Promise.all([firstDone, secondDone]);

    expect(calls).toEqual(["first", "second"]);
    expect(queue.size()).toBe(0);
  });

  it("keeps a busy item at the head and retries it", async () => {
    const busy = new Error("busy");
    const calls: PromptQueueItem[] = [];
    const queue = new PromptQueueController({
      isBusyError: (error): boolean => error === busy,
      retryDelayMs: 0,
      submit(item): Promise<void> {
        calls.push(item);
        return calls.length === 1 ? Promise.reject(busy) : Promise.resolve();
      },
    });

    await queue.enqueue({ sessionId: "session_1", text: "retry me" });

    expect(calls.map((item) => item.text)).toEqual(["retry me", "retry me"]);
    expect(queue.size()).toBe(0);
  });

  it("rejects unsent prompts when closed", async () => {
    const first = deferred();
    const queue = new PromptQueueController({
      isBusyError: (): boolean => false,
      retryDelayMs: 0,
      async submit(): Promise<void> {
        await first.promise;
      },
    });

    const firstDone = queue.enqueue({ sessionId: "session_1", text: "first" });
    const secondDone = queue.enqueue({
      sessionId: "session_1",
      text: "second",
    });
    await vi.waitUntil(() => queue.size() === 1);

    queue.close();
    first.resolve(undefined);

    await expect(firstDone).resolves.toBeUndefined();
    await expect(secondDone).rejects.toBeInstanceOf(PromptQueueClosedError);
    expect(queue.size()).toBe(0);
  });

  it("rejects a busy-retrying prompt on close and does not submit it again", async () => {
    vi.useFakeTimers();
    try {
      const busy = new Error("busy");
      const calls: string[] = [];
      const queue = new PromptQueueController({
        isBusyError: (error): boolean => error === busy,
        retryDelayMs: 1_000,
        submit(item): Promise<void> {
          calls.push(item.text);
          return Promise.reject(busy);
        },
      });

      const done = queue.enqueue({
        sessionId: "session_1",
        text: "retry until closed",
      });
      let rejection: unknown;
      void done.catch((error: unknown) => {
        rejection = error;
      });
      await Promise.resolve();
      expect(calls).toEqual(["retry until closed"]);

      queue.close();
      await Promise.resolve();
      expect(rejection).toBeInstanceOf(PromptQueueClosedError);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual(["retry until closed"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
