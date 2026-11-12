/* eslint-disable @typescript-eslint/require-await -- Fake adapters exercise eager calls and lazy async iterators without external I/O. */
import type { InterfaceProviderStreamEvent } from "../providers/types.js";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapResponsesStream } from "../providers/openai-responses-stream.js";
import {
  createInterfaceProvider,
  ModelRequestValidationError,
} from "../providers/index.js";
import { providerErrorDetail } from "./provider-error.js";
import { streamResponse } from "./streaming.js";
import type {
  LLMClientInstance,
  ModelRequestObservation,
  StreamingResponse,
} from "./types.js";

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

describe("request attempt observations", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["anthropic", "openai-compatible", "openai-responses"] as const)(
    "preserves local %s request validation without sending or retrying",
    async (kind) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected HTTP"));
      const provider = createInterfaceProvider({
        id: "test",
        interfaceProvider: kind,
        apiKey: "fake-test-key",
        baseUrl: "http://localhost",
      });
      const open = vi.spyOn(provider, "streamResponse");
      const facts: ModelRequestObservation[] = [];
      let failure: unknown;
      try {
        for await (const _ of streamResponse(
          { config: { ...config, interfaceProvider: kind }, provider },
          [
            {
              role: "user",
              content: "test",
              ...(kind === "anthropic" ? {} : { tool_calls: [] }),
            },
          ],
          {
            tools: [{ name: "x", inputSchema: { type: "string" } }],
            onRequestObservation: async (fact) => {
              facts.push(fact);
            },
          },
        )) {
          /* consume */
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelRequestValidationError);
      expect((failure as Error).message).toMatch(
        /object JSON schema|legacy model message|unsupported field/,
      );
      expect(providerErrorDetail(failure)).toBeUndefined();
      expect(open).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(facts.at(-1)?.request.outcome).toBe("error");
      expect(facts.at(-1)?.request.retryScheduled).toBeUndefined();
    },
  );
  it.each([false, true])(
    "waits for durable attempt admission before provider I/O (cancel=%s)",
    async (cancel) => {
      const saved = deferred();
      const entered = deferred();
      const abort = new AbortController();
      let calls = 0;
      let admittedId: string | undefined;
      const facts: ModelRequestObservation[] = [];
      const client: LLMClientInstance = {
        config,
        provider: {
          id: "test",
          kind: "openai-compatible",
          client: {},
          async streamResponse() {
            calls++;
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              yield { textDelta: "result" };
              yield { finishReason: "stop" };
            })();
          },
          isAbortError: () => false,
        },
      };
      const consuming = (async (): Promise<void> => {
        for await (const _ of streamResponse(client, [], {
          signal: abort.signal,
          beforeRequestAttempt: async (record) => {
            admittedId = record.requestId;
            entered.resolve();
            await saved.promise;
          },
          onRequestObservation: async (fact) => {
            facts.push(fact);
          },
        })) {
          /* consume */
        }
      })();
      try {
        // Let a missing admission implementation reach I/O instead of hanging the test.
        await Promise.race([entered.promise, consuming]);
        expect(calls).toBe(0);
        if (cancel) abort.abort("stopped before attempt admission completed");
        else saved.resolve();
        await consuming;
        expect(calls).toBe(cancel ? 0 : 1);
        expect(facts.map((fact) => fact.request.requestId)).toEqual(
          cancel ? [] : [admittedId, admittedId, admittedId],
        );
      } finally {
        saved.resolve();
        await consuming;
      }
    },
  );

  it("does not retry provider I/O when durable attempt admission fails", async () => {
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
            yield { finishReason: "stop" };
          })();
        },
        isAbortError: () => false,
      },
    };
    const consuming = async (): Promise<void> => {
      for await (const _ of streamResponse(client, [], {
        beforeRequestAttempt: async () => {
          throw new Error("input ledger unavailable");
        },
      })) {
        /* consume */
      }
    };
    const result = consuming();
    await expect(result).rejects.toHaveProperty(
      "name",
      "ModelObservationError",
    );
    await expect(result).rejects.toThrow("input ledger unavailable");
    expect(calls).toBe(0);
  });
  it.each(["response.failed", "response.private-provider-payload"])(
    "retains safe provider provenance for early Responses mapper failures (%s)",
    async (type) => {
      let calls = 0;
      const facts: ModelRequestObservation[] = [];
      const chunks: StreamingResponse[] = [];
      const client: LLMClientInstance = {
        config: { ...config, interfaceProvider: "openai-responses" },
        provider: {
          id: "test",
          kind: "openai-responses",
          client: {},
          async streamResponse() {
            calls++;
            return mapResponsesStream(
              (async function* (): AsyncGenerator<ResponseStreamEvent> {
                yield { type } as ResponseStreamEvent;
              })(),
            );
          },
          isAbortError: () => false,
        },
      };
      let failure: unknown;
      try {
        for await (const chunk of streamResponse(client, [], {
          onRequestObservation: async (fact) => {
            facts.push(fact);
          },
        }))
          chunks.push(chunk);
      } catch (error) {
        failure = error;
      }
      expect(calls).toBe(1);
      expect(failure).toMatchObject({ name: "ProviderRequestError" });
      expect(providerErrorDetail(failure)).toEqual({
        kind: "unknown",
        message: "The response could not be completed. Please try again.",
        retryable: false,
      });
      expect(chunks.some((chunk) => chunk.isComplete || chunk.retry)).toBe(
        false,
      );
      const ended = facts.filter((fact) => fact.type === "request-ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({
        request: { outcome: "error" },
        failure: { kind: "unknown" },
      });
      expect(ended[0].request).not.toHaveProperty("retryScheduled");
      expect(JSON.stringify(ended[0])).not.toContain(
        "private-provider-payload",
      );
    },
  );
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
    expect(facts[1].request).not.toHaveProperty("retryScheduled");
  });
  it("does not invoke an adapter after cancellation during request preparation", async () => {
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
    const facts: ModelRequestObservation[] = [];
    for await (const _ of streamResponse(client, [], {
      signal: abort.signal,
      onRequestObservation: async (fact) => {
        facts.push(fact);
      },
    })) {
      /* consume */
    }
    expect(calls).toBe(0);
    expect(facts).toEqual([]);
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
        attempt: 1,
        outcome: "running",
      });
      // The client reports measurements only; attribution belongs to callers.
      expect(facts[0].request).not.toHaveProperty("runId");
      expect(facts[0].request).not.toHaveProperty("purpose");
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
    expect(facts[1].request).toHaveProperty("retryScheduled", true);
    for (const fact of [facts[0], facts[2], facts[3]])
      expect(fact.request).not.toHaveProperty("retryScheduled");
    calls = 0;
    await expect(
      (async (): Promise<void> => {
        for await (const _ of streamResponse(client, [], {
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

  it.each(["retry", "abort", "save-error", "abort-save-error"] as const)(
    "seals the retry plan before end persistence completes (%s)",
    async (completion) => {
      const saved = deferred();
      const ending = deferred();
      const abort = new AbortController();
      const facts: ModelRequestObservation[] = [];
      const chunks: StreamingResponse[] = [];
      let calls = 0;
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
              yield { finishReason: "stop" };
            })();
          },
          isAbortError: () => false,
        },
      };
      const running = (async (): Promise<unknown> => {
        try {
          for await (const chunk of streamResponse(client, [], {
            signal: abort.signal,
            retry: { initialDelayMs: 0 },
            onRequestObservation: async (fact) => {
              facts.push(fact);
              if (fact.type !== "request-ended" || fact.request.attempt !== 1)
                return;
              ending.resolve();
              await saved.promise;
              if (completion.includes("save-error"))
                throw Object.assign(new Error("end save failed"), {
                  status: 503,
                });
            },
          }))
            chunks.push(chunk);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      try {
        await ending.promise;
        const ended = facts.at(-1);
        expect(ended?.request).toMatchObject({
          attempt: 1,
          outcome: "error",
          retryScheduled: true,
        });
        expect(calls).toBe(1);
        expect(
          chunks.some(
            (chunk) =>
              chunk.requestObservation?.type === "request-ended" ||
              chunk.retry !== undefined,
          ),
        ).toBe(false);
        if (completion.includes("abort")) abort.abort();
        saved.resolve();
        const result = await running;
        expect(facts.find((fact) => fact.type === "request-ended")).toBe(ended);
        expect(ended?.request).toMatchObject({
          outcome: "error",
          retryScheduled: true,
        });
        if (completion.includes("save-error")) {
          expect(result).toMatchObject({
            name: "ModelObservationError",
            cause: { message: "end save failed" },
          });
          expect(
            chunks.some(
              (chunk) => chunk.requestObservation?.type === "request-ended",
            ),
          ).toBe(false);
        } else {
          expect(result).toBeUndefined();
          expect(chunks.at(-1)?.streamStopReason).toBe(
            completion === "abort" ? "user_aborted" : "provider_finished",
          );
        }
        expect(calls).toBe(completion === "retry" ? 2 : 1);
        expect(chunks.filter((chunk) => chunk.retry)).toHaveLength(
          completion === "retry" ? 1 : 0,
        );
      } finally {
        saved.resolve();
        abort.abort();
        await running;
      }
    },
  );
});
