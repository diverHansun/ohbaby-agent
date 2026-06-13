import { describe, expect, it, vi } from "vitest";
import {
  DaemonPromptQueue,
  DaemonPromptQueueShutdownError,
} from "./prompt-queue.js";

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

describe("DaemonPromptQueue", () => {
  it("runs same-session prompts in submit order", async () => {
    const firstGate = deferred();
    const calls: string[] = [];
    const queue = new DaemonPromptQueue({
      submit(item): Promise<void> {
        calls.push(item.text);
        return item.text === "A" ? firstGate.promise : Promise.resolve();
      },
    });

    const first = queue.enqueue({
      clientId: "client_a",
      sessionId: "session_1",
      text: "A",
    });
    const second = queue.enqueue({
      clientId: "client_b",
      sessionId: "session_1",
      text: "B",
    });

    await vi.waitUntil(() => calls.length === 1);
    expect(calls).toEqual(["A"]);
    expect(queue.size).toBe(1);

    firstGate.resolve(undefined);
    await Promise.all([first, second]);

    expect(calls).toEqual(["A", "B"]);
    expect(queue.size).toBe(0);
  });

  it("runs different sessions concurrently", async () => {
    const release = deferred();
    const active = new Set<string>();
    const seen: string[] = [];
    const queue = new DaemonPromptQueue({
      async submit(item): Promise<void> {
        active.add(item.sessionId ?? "__fresh__");
        seen.push(`${item.text}:${String(active.size)}`);
        if (item.text === "A") {
          await release.promise;
        }
        active.delete(item.sessionId ?? "__fresh__");
      },
    });

    const first = queue.enqueue({
      clientId: "client_a",
      sessionId: "session_1",
      text: "A",
    });
    const second = queue.enqueue({
      clientId: "client_b",
      sessionId: "session_2",
      text: "B",
    });

    await vi.waitUntil(() => seen.length === 2);
    release.resolve(undefined);
    await Promise.all([first, second]);

    expect(seen).toEqual(["A:1", "B:2"]);
  });

  it("serializes fresh-session prompts into one lane", async () => {
    const firstGate = deferred();
    const calls: string[] = [];
    const queue = new DaemonPromptQueue({
      submit(item): Promise<void> {
        calls.push(item.text);
        return item.text === "A" ? firstGate.promise : Promise.resolve();
      },
    });

    const first = queue.enqueue({ clientId: "client_a", text: "A" });
    const second = queue.enqueue({ clientId: "client_b", text: "B" });

    await vi.waitUntil(() => calls.length === 1);
    expect(calls).toEqual(["A"]);

    firstGate.resolve(undefined);
    await Promise.all([first, second]);
    expect(calls).toEqual(["A", "B"]);
  });

  it("does not cancel accepted prompts when a client disconnects", async () => {
    const calls: string[] = [];
    const queue = new DaemonPromptQueue({
      submit(item): Promise<void> {
        calls.push(`${item.clientId}:${item.text}`);
        return Promise.resolve();
      },
    });

    const accepted = queue.enqueue({
      clientId: "client_a",
      sessionId: "session_1",
      text: "A",
    });
    queue.disconnectClient("client_a");

    await accepted;
    expect(calls).toEqual(["client_a:A"]);
  });

  it("rejects accepted but unstarted prompts on shutdown", async () => {
    const gate = deferred();
    const queue = new DaemonPromptQueue({
      submit(): Promise<void> {
        return gate.promise;
      },
    });

    const first = queue.enqueue({
      clientId: "client_a",
      sessionId: "session_1",
      text: "A",
    });
    const second = queue.enqueue({
      clientId: "client_b",
      sessionId: "session_1",
      text: "B",
    });
    await vi.waitUntil(() => queue.size === 1);

    queue.shutdown("daemon stopped");
    await expect(second).rejects.toBeInstanceOf(DaemonPromptQueueShutdownError);

    gate.resolve(undefined);
    await first;
  });

  it("keeps a busy prompt at the head and retries it", async () => {
    const busy = new Error("busy");
    const calls: string[] = [];
    const queue = new DaemonPromptQueue({
      isBusyError: (error): boolean => error === busy,
      retryDelayMs: 0,
      submit(item): Promise<void> {
        calls.push(item.text);
        return calls.length === 1 ? Promise.reject(busy) : Promise.resolve();
      },
    });

    await queue.enqueue({
      clientId: "client_a",
      sessionId: "session_1",
      text: "retry",
    });

    expect(calls).toEqual(["retry", "retry"]);
  });
});
