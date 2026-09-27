/* eslint-disable @typescript-eslint/require-await -- Fake adapters exercise eager calls and lazy async iterators without external I/O. */
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamResponse } from "./streaming.js";
import type { LLMClientInstance, ModelRequestObservation } from "./types.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const config: LLMClientInstance["config"] = {
  provider: "test",
  model: "test",
  interfaceProvider: "openai-compatible",
  baseUrl: "http://localhost",
  maxTokens: 128,
};
const owner = { runId: "run", step: 1, messageId: "message" };

describe("request attempt observations", () => {
  afterEach(() => vi.restoreAllMocks());
  it("closes a late-opening iterator once after cancellation, observing close rejection", async () => {
    const opening = deferred<AsyncIterable<InterfaceProviderStreamEvent>>();
    const started = deferred();
    const abort = new AbortController();
    const close = vi.fn().mockRejectedValue(new Error("late close failed"));
    const client: LLMClientInstance = {
      config,
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        streamResponse: () => opening.promise,
        isAbortError: () => false,
      },
    };
    const consuming = (async (): Promise<void> => {
      for await (const _ of streamResponse(client, [], {
        signal: abort.signal,
        requestOwner: owner,
        onRequestObservation: async (fact) => {
          if (fact.type === "request-started") started.resolve();
        },
      })) {
        /* consume */
      }
    })();
    await started.promise;
    abort.abort();
    await consuming;
    opening.resolve({
      [Symbol.asyncIterator]: () => ({ next: vi.fn(), return: close }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("samples first text and end when received rather than when their saves finish", async () => {
    let now = 10;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const startSave = deferred();
    const endSave = deferred();
    const textReceived = deferred();
    const endReceived = deferred();
    const facts: ModelRequestObservation[] = [];
    const client: LLMClientInstance = {
      config,
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        async streamResponse() {
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            now = 20;
            textReceived.resolve();
            yield { textDelta: "hello" };
            yield { finishReason: "stop" as const };
          })();
        },
        isAbortError: () => false,
      },
    };
    const running = (async (): Promise<void> => {
      for await (const _ of streamResponse(client, [], {
        requestOwner: owner,
        onRequestObservation: async (fact) => {
          facts.push(fact);
          if (fact.type === "request-started") await startSave.promise;
          if (fact.type === "request-ended") {
            endReceived.resolve();
            await endSave.promise;
          }
        },
      })) {
        /* consume */
      }
    })();
    try {
      await textReceived.promise;
      for (let i = 0; i < 5; i++) await Promise.resolve();
      now = 100;
      startSave.resolve();
      await endReceived.promise;
      now = 999;
      endSave.resolve();
      await running;
      expect(facts[0].request.startedAt).toBe(10);
      expect(facts[1].request.firstTextAt).toBe(20);
      expect(facts[2].request.endedAt).toBe(100);
    } finally {
      startSave.resolve();
      endSave.resolve();
      clock.mockRestore();
    }
  });
  it("captures abort while start save is blocked and never revives from late text", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10);
    const save = deferred();
    const opened = deferred();
    const stream = deferred<AsyncIterable<InterfaceProviderStreamEvent>>();
    const abort = new AbortController();
    const facts: ModelRequestObservation[] = [];
    let receivedSignal: AbortSignal | undefined;
    const client: LLMClientInstance = {
      config,
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        streamResponse(request) {
          receivedSignal = request.signal;
          opened.resolve();
          return stream.promise;
        },
        isAbortError: () => false,
      },
    };
    const run = (async (): Promise<void> => {
      for await (const _ of streamResponse(client, [], {
        signal: abort.signal,
        requestOwner: owner,
        onRequestObservation: async (fact) => {
          facts.push(fact);
          if (fact.type === "request-started") await save.promise;
        },
      })) {
        /* consume */
      }
    })();
    await opened.promise;
    clock.mockReturnValue(20);
    abort.abort();
    const abortedAt = 20;
    clock.mockReturnValue(100);
    expect(receivedSignal?.aborted).toBe(true);
    save.resolve();
    await run;
    stream.resolve(
      (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
        yield { textDelta: "late" };
      })(),
    );
    await Promise.resolve();
    expect(facts.map((f) => f.type)).toEqual([
      "request-started",
      "request-ended",
    ]);
    expect(facts[1].request).toMatchObject({
      outcome: "aborted",
      endedAt: abortedAt,
    });
  });
  it("does not invoke an adapter after cancellation during owner preparation", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const client: LLMClientInstance = {
      config,
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        async streamResponse() {
          calls++;
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            yield { finishReason: "stop" as const };
          })();
        },
        isAbortError: () => false,
      },
    };
    for await (const _ of streamResponse(client, [], {
      signal: abort.signal,
      requestOwner: owner,
    })) {
      /* consume */
    }
    expect(calls).toBe(0);
  });
  it.each(["call", "iterator"] as const)(
    "starts %s I/O before waiting for its start save",
    async (streamStart) => {
      const save = deferred();
      const io = deferred();
      const release = deferred();
      const facts: ModelRequestObservation[] = [];
      const client: LLMClientInstance = {
        config,
        provider: {
          id: "test",
          kind: "openai-compatible",
          client: {},
          streamStart,
          async streamResponse() {
            if (streamStart === "call") {
              io.resolve();
              await release.promise;
            }
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (streamStart === "iterator") io.resolve();
              yield { textDelta: "" };
              yield { reasoningTextDelta: "reason" };
              yield { textDelta: "hello" };
              yield { finishReason: "stop" as const };
            })();
          },
          isAbortError: () => false,
        },
      };
      const run = (async (): Promise<void> => {
        for await (const _ of streamResponse(client, [], {
          purpose: "agent-step",
          sessionId: "session",
          requestOwner: owner,
          onRequestObservation: async (fact) => {
            facts.push(fact);
            if (fact.type === "request-started") await save.promise;
          },
        })) {
          /* consume */
        }
      })();
      await io.promise;
      expect(facts.map((f) => f.type)).toEqual(["request-started"]);
      release.resolve();
      save.resolve();
      await run;
      expect(facts.map((f) => f.type)).toEqual([
        "request-started",
        "first-text",
        "request-ended",
      ]);
      expect(facts[0].request).toMatchObject({
        ...owner,
        purpose: "agent-step",
        outcome: "running",
      });
      expect(facts[2].request.outcome).toBe("success");
      expect(facts[2].request.firstTextAt).toBeTypeOf("number");
      expect(facts[2].request.endedAt).toBeTypeOf("number");
    },
  );
  it("ends failed attempts before retry and does not retry observation save failures", async () => {
    let calls = 0;
    const facts: ModelRequestObservation[] = [];
    const client: LLMClientInstance = {
      config,
      provider: {
        id: "test",
        kind: "openai-compatible",
        client: {},
        async streamResponse() {
          calls++;
          if (calls === 1)
            throw Object.assign(new Error("busy"), { status: 503 });
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            yield { finishReason: "stop" as const };
          })();
        },
        isAbortError: () => false,
      },
    };
    for await (const _ of streamResponse(client, [], {
      requestOwner: owner,
      retry: { initialDelayMs: 0 },
      onRequestObservation: async (f) => {
        facts.push(f);
      },
    })) {
      /* consume */
    }
    expect(
      facts.map((f) => [f.type, f.request.attempt, f.request.outcome]),
    ).toEqual([
      ["request-started", 1, "running"],
      ["request-ended", 1, "error"],
      ["request-started", 2, "running"],
      ["request-ended", 2, "success"],
    ]);
    expect(new Set(facts.map((f) => f.request.requestId)).size).toBe(2);
    calls = 0;
    await expect(
      (async (): Promise<void> => {
        for await (const _ of streamResponse(client, [], {
          requestOwner: owner,
          onRequestObservation: async () => {
            throw Object.assign(new Error("save failed"), { status: 503 });
          },
        })) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("save failed");
    expect(calls).toBe(1);
  });
});
