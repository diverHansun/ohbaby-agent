import { describe, expect, it, vi } from "vitest";
import {
  DaemonEventsRejectedError,
  EVENT_STREAM_ATTEMPT_TIMEOUT_MS,
  FetchDaemonEventStream,
} from "./events.js";

describe("daemon event stream lifecycle", () => {
  it("cancels a silent response reader on close and does not announce reconnect", async () => {
    const cancel = vi.fn();
    const states: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"hello"}\n\n'),
        );
      },
      cancel,
    });
    const stream = new FetchDaemonEventStream({
      baseUrl: "http://fixture",
      clientId: "client",
      token: "token",
      fetch: (): Promise<Response> => Promise.resolve(new Response(body)),
    });
    await stream.start({
      onConnectionState: (state) => {
        states.push(state);
      },
    });
    await stream.close();
    expect(cancel).toHaveBeenCalledOnce();
    expect(states).toEqual(["connecting", "live"]);
    expect(body.locked).toBe(false);
  }, 1000);
});

describe("daemon event stream retries", () => {
  const hello = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"hello"}\n\n'),
          );
          controller.close();
        },
      }),
    );
  const hanging = (init?: RequestInit): Promise<Response> =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  it("stops for good when the daemon no longer knows the page", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(hello())
        .mockResolvedValue(new Response("{}", { status: 401 }));
      const errors: Error[] = [];
      const stream = new FetchDaemonEventStream({
        baseUrl: "http://fixture",
        clientId: "client",
        token: "token",
        fetch,
      });
      await stream.start({ onError: (error) => errors.push(error) });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(DaemonEventsRejectedError);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a stalled attempt after its deadline and keeps trying", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(hello())
        .mockImplementationOnce((_, init) => hanging(init))
        .mockImplementation((_, init) => hanging(init));
      const errors: string[] = [];
      const stream = new FetchDaemonEventStream({
        baseUrl: "http://fixture",
        clientId: "client",
        token: "token",
        fetch,
      });
      await stream.start({ onError: (error) => errors.push(error.message) });
      // The first stream ends; the next attempt opens after a 250ms pause.
      await vi.advanceTimersByTimeAsync(250);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(EVENT_STREAM_ATTEMPT_TIMEOUT_MS - 1);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toEqual(["Daemon SSE did not respond in time"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries again at once when woken instead of waiting out the backoff", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(hello())
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockImplementation((_, init) => hanging(init));
      const stream = new FetchDaemonEventStream({
        baseUrl: "http://fixture",
        clientId: "client",
        token: "token",
        fetch,
      });
      await stream.start({});
      // hello ends -> reconnect after 250ms -> fails -> waits 500ms
      await vi.advanceTimersByTimeAsync(300);
      expect(fetch).toHaveBeenCalledTimes(2);
      stream.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      // The third attempt hangs; waking drops it rather than waiting 10s.
      stream.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(4);
      await stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
