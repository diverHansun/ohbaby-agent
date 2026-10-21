/* eslint-disable @typescript-eslint/require-await -- Fake adapters return controlled promises without external I/O. */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent as Event,
} from "../providers/types.js";
import type {
  LLMClientInstance,
  ModelRequestObservation,
  StreamingResponse,
} from "./types.js";
import { streamResponse } from "./streaming.js";
import {
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "./retry.js";
import { ProviderStreamIdleTimeoutError } from "./idle-watchdog.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

const messages = [{ role: "user" as const, content: "test" }];
const owner = { runId: "run-idle", messageId: "message-idle", step: 1 };
const retry = { maxRetriesPerStep: 1, initialDelayMs: 20, maxDelayMs: 20 };
const never = <T>(): Promise<T> =>
  new Promise(() => {
    /* provider ignores cancellation */
  });

type TestIterator = AsyncIterableIterator<Event> & {
  next: Mock<() => Promise<IteratorResult<Event>>>;
  return: Mock<() => Promise<IteratorResult<Event>>>;
};

function stream(
  events: Event[],
  tail?: Promise<IteratorResult<Event>>,
): TestIterator {
  const queue = [...events];
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<Event>> => {
      const value = queue.shift();
      return value
        ? { value, done: false }
        : (tail ?? { value: undefined, done: true });
    }),
    return: vi.fn(() => never<IteratorResult<Event>>()),
    [Symbol.asyncIterator](): TestIterator {
      return this;
    },
  };
  return iterator;
}
function fixture(
  open: (request: InterfaceProviderRequest) => Promise<AsyncIterable<Event>>,
  lazy = false,
): {
  client: LLMClientInstance;
  provider: LLMClientInstance["provider"] & {
    streamResponse: Mock<typeof open>;
    isAbortError: Mock<(error?: unknown) => boolean>;
  };
} {
  const provider = {
    id: "idle-fixture",
    kind: "openai-compatible" as const,
    ...(lazy ? { streamStart: "iterator" as const } : {}),
    client: {},
    streamResponse: vi.fn(open),
    isAbortError: vi.fn<(error?: unknown) => boolean>(() => false),
  };
  const client: LLMClientInstance = {
    provider,
    config: {
      provider: "idle-fixture",
      model: "fixture",
      baseUrl: "https://fixture.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      promptCache: "disabled",
      modelProfiles: [
        {
          model: "fixture",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
  };
  return { client, provider };
}
function collect(
  client: LLMClientInstance,
  options: Parameters<typeof streamResponse>[2] = {},
): {
  result: Promise<unknown>;
  chunks: StreamingResponse[];
  records: ModelRequestObservation[];
} {
  const chunks: StreamingResponse[] = [];
  const records: ModelRequestObservation[] = [];
  const result = (async (): Promise<unknown> => {
    try {
      for await (const item of streamResponse(client, messages, {
        idleTimeoutMs: 100,
        retry,
        requestOwner: owner,
        onRequestObservation: async (record) => {
          records.push(record);
        },
        ...options,
      }))
        chunks.push(item);
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  return { result, chunks, records };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("streamResponse idle protection", () => {
  it.each([0, -1, NaN, Infinity, 2_147_483_648])(
    "rejects idleTimeoutMs=%s before provider I/O",
    async (idleTimeoutMs) => {
      const { client, provider } = fixture(async () =>
        stream([{ finishReason: "stop" }]),
      );
      const run = collect(client, { idleTimeoutMs });
      expect(await run.result).toBeInstanceOf(RangeError);
      expect(provider.streamResponse).not.toHaveBeenCalled();
    },
  );

  it.each(["opening", "first", "usage-only", "loop"] as const)(
    "bounds %s, retries only through the existing loop",
    async (stage) => {
      const usage: Event = {
        tokenUsage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      };
      const streams: ReturnType<typeof stream>[] = [];
      const { client, provider } = fixture(async () => {
        if (stage === "opening") return never();
        const source = stream(
          stage === "usage-only" ? [usage] : stage === "loop" ? [{}] : [],
          never(),
        );
        streams.push(source);
        return source;
      });
      const caller = new AbortController();
      const run = collect(client, { signal: caller.signal });
      await vi.advanceTimersByTimeAsync(220);
      expect(await run.result).toBeInstanceOf(ProviderRetryExhaustedError);
      expect(await run.result).toMatchObject({
        attempts: 1,
        cause: { code: "PROVIDER_STREAM_IDLE_TIMEOUT" },
      });
      expect(provider.streamResponse).toHaveBeenCalledTimes(2);
      expect(
        provider.streamResponse.mock.calls.every(([r]) => r.signal?.aborted),
      ).toBe(true);
      expect(caller.signal.aborted).toBe(false);
      expect(
        run.chunks.filter((r) => r.retry).map((r) => r.retry?.reason),
      ).toEqual(["stream_idle_timeout"]);
      expect(
        run.records
          .filter((r) => r.type === "request-ended")
          .map((r) => r.request.outcome),
      ).toEqual(["error", "error"]);
      for (const source of streams)
        expect(source.return).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { textDelta: "partial" },
    { reasoningTextDelta: "thinking" },
    {
      toolCallDeltas: [
        { index: 0, id: "call", name: "write", argumentsDelta: "{" },
      ],
    },
    { finishReason: "stop" as const },
  ])("does not replay committed output %j", async (event) => {
    const { client, provider } = fixture(async () => stream([event], never()));
    const run = collect(client);
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toBeInstanceOf(ProviderStreamInterruptedError);
    expect(await run.result).toMatchObject({
      cause: { code: "PROVIDER_STREAM_IDLE_TIMEOUT" },
      source: undefined,
    });
    expect(provider.streamResponse).toHaveBeenCalledOnce();
    expect(run.chunks.some((c) => c.retry)).toBe(false);
  });

  it("keeps a partial summary timeout outside Context's transport retry", async () => {
    const { client, provider } = fixture(async () =>
      stream([{ textDelta: "partial summary" }], never()),
    );
    const run = collect(client, {
      purpose: "context-summary",
      requestOwner: undefined,
      retry: { maxRetriesPerStep: 0 },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toBeInstanceOf(ProviderStreamInterruptedError);
    expect(
      ((await run.result) as ProviderStreamInterruptedError).source,
    ).toBeUndefined();
    expect(provider.streamResponse).toHaveBeenCalledOnce();
  });

  it.each(["before", "same-tick", "backoff"] as const)(
    "preserves user cancellation %s timeout",
    async (when) => {
      const caller = new AbortController();
      const { client, provider } = fixture(async () => never());
      const run = collect(client, { signal: caller.signal });
      await vi.advanceTimersByTimeAsync(0);
      if (when === "backoff") await vi.advanceTimersByTimeAsync(100);
      else if (when === "same-tick") vi.advanceTimersByTime(100);
      caller.abort(new Error("user stop"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await run.result).toBeUndefined();
      expect(run.chunks.at(-1)?.streamStopReason).toBe("user_aborted");
      expect(provider.streamResponse).toHaveBeenCalledOnce();
      if (when !== "backoff")
        expect(run.chunks.some((c) => c.retry)).toBe(false);
    },
  );

  it("normalizes an SDK abort raised by the timeout to idle timeout", async () => {
    const sdkAbort = new Error("SDK abort");
    const { client, provider } = fixture(
      (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              reject(sdkAbort);
            },
            {
              once: true,
            },
          );
        }),
    );
    provider.isAbortError.mockImplementation((e?: unknown) => e === sdkAbort);
    const run = collect(client, { retry: { maxRetriesPerStep: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toBeInstanceOf(ProviderRetryExhaustedError);
    expect(
      ((await run.result) as ProviderRetryExhaustedError).cause,
    ).toBeInstanceOf(ProviderStreamIdleTimeoutError);
  });

  for (const lazy of [false, true]) {
    for (const timing of ["backoff", "after-finally"] as const) {
      it.each(["resolve", "reject"] as const)(
        `isolates late opening %s (${timing}, lazy=${String(lazy)})`,
        async (settle) => {
          const opening = deferred<AsyncIterable<Event>>();
          const late = stream([{ textDelta: "stale", finishReason: "stop" }]);
          let attempt = 0;
          const { client, provider } = fixture(
            async () =>
              ++attempt === 1
                ? opening.promise
                : stream([{ textDelta: "clean", finishReason: "stop" }]),
            lazy,
          );
          const run = collect(client);
          await vi.advanceTimersByTimeAsync(timing === "backoff" ? 100 : 120);
          const recordsBefore = [...run.records];
          if (settle === "resolve") opening.resolve(late);
          else opening.reject(new Error("late opening failed"));
          await vi.advanceTimersByTimeAsync(0);
          expect(run.records).toEqual(recordsBefore);
          expect(late.next).not.toHaveBeenCalled();
          if (settle === "resolve") expect(late.return).toHaveBeenCalledOnce();
          if (timing === "backoff") await vi.advanceTimersByTimeAsync(20);
          expect(await run.result).toBeUndefined();
          expect(provider.streamResponse).toHaveBeenCalledTimes(2);
          expect(run.chunks.at(-1)?.messageSnapshot.content).toBe("clean");
          expect(
            run.records.filter((r) => r.type === "request-started"),
          ).toHaveLength(lazy ? 1 : 2);
        },
      );
    }
  }

  it.each(["resolve", "reject"] as const)(
    "ignores late next %s without observer changes or waiting for return",
    async (settle) => {
      const pending = deferred<IteratorResult<Event>>();
      const old = stream([], pending.promise);
      let attempt = 0;
      const { client } = fixture(async () =>
        ++attempt === 1
          ? old
          : stream([{ textDelta: "clean", finishReason: "stop" }]),
      );
      const run = collect(client);
      await vi.advanceTimersByTimeAsync(120);
      expect(await run.result).toBeUndefined();
      const records = [...run.records];
      if (settle === "resolve")
        pending.resolve({ done: false, value: { textDelta: "stale" } });
      else pending.reject(new Error("late next failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(run.records).toEqual(records);
      expect(old.return).toHaveBeenCalledOnce();
      expect(run.chunks.at(-1)?.messageSnapshot.content).toBe("clean");
    },
  );

  it("does not time consumer work between next calls", async () => {
    const { client } = fixture(async () =>
      stream([
        { textDelta: "one" },
        { textDelta: "two", finishReason: "stop" },
      ]),
    );
    const iterator = streamResponse(client, messages, { idleTimeoutMs: 100 });
    expect((await iterator.next()).value?.messageSnapshot.content).toBe("one");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await iterator.next()).value?.messageSnapshot.content).toBe(
      "onetwo",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await iterator.next()).value?.isComplete).toBe(true);
    await iterator.next();
  });

  it("resets on activity without normalized events and allows long total duration", async () => {
    const pending = deferred<IteratorResult<Event>>();
    const { client, provider } = fixture(async () =>
      stream([], pending.promise),
    );
    const iterator = streamResponse(client, messages, { idleTimeoutMs: 100 });
    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(90);
      provider.streamResponse.mock.calls[0][0].onActivity?.();
    }
    pending.resolve({ done: false, value: { textDelta: "alive" } });
    expect((await first).value?.messageSnapshot.content).toBe("alive");
    await iterator.return();
  });
});

it("records timeout receipt before slow persistence and ignores late first text", async () => {
  const saved = deferred<undefined>();
  const pending = deferred<IteratorResult<Event>>();
  const facts: ModelRequestObservation[] = [];
  const { client } = fixture(async () => stream([], pending.promise));
  const start = Date.now();
  const run = collect(client, {
    retry: { maxRetriesPerStep: 0 },
    onRequestObservation: async (fact) => {
      facts.push(fact);
      if (fact.type === "request-started") await saved.promise;
    },
  });
  await vi.advanceTimersByTimeAsync(100);
  pending.resolve({ done: false, value: { textDelta: "too late" } });
  await vi.advanceTimersByTimeAsync(1000);
  saved.resolve(undefined);
  expect(await run.result).toBeInstanceOf(ProviderRetryExhaustedError);
  expect(facts.map((f) => f.type)).toEqual([
    "request-started",
    "request-ended",
  ]);
  expect(facts.at(-1)?.request).toMatchObject({
    outcome: "error",
    endedAt: start + 100,
  });
});

it("gives opening and first next independent idle intervals", async () => {
  const opening = deferred<AsyncIterable<Event>>();
  const { client, provider } = fixture(() => opening.promise);
  const run = collect(client, { retry: { maxRetriesPerStep: 0 } });
  await vi.advanceTimersByTimeAsync(90);
  opening.resolve(stream([], never()));
  await vi.advanceTimersByTimeAsync(99);
  expect(provider.streamResponse.mock.calls[0][0].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run.result).toBeInstanceOf(ProviderRetryExhaustedError);
});
