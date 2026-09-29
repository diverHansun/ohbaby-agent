import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionSync } from "./session-sync.js";
import type { UiSessionView } from "./session-view.js";
function view(revision = 0, text = "base"): UiSessionView {
  return {
    version: {
      runtimeEpoch: "epoch",
      sessionId: "s",
      viewGeneration: "view",
      sessionRevision: revision,
    },
    session: {
      id: "s",
      title: "s",
      createdAt: "2026",
      updatedAt: "2026",
      messages: [
        {
          id: "m",
          role: "assistant",
          createdAt: "2026",
          parts: [{ type: "text", text }],
        },
      ],
    },
    runs: [],
    prompts: [],
    history: { hasMore: false },
    reasoningMissing: false,
    todo: { status: "ready", value: null },
    goal: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const scope = { sessionId: "s", runtimeEpoch: "epoch" };
afterEach(() => vi.useRealTimers());
describe("bounded session recovery", () => {
  it("reads continuously while the baseline is pending and rejects late prior requests", async () => {
    const first = deferred<UiSessionView>();
    const second = deferred<UiSessionView>();
    const query = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    sync.receive({
      type: "session.changed",
      version: { ...view().version, sessionRevision: 1 },
      messages: view(1, "next").session.messages,
    });
    first.resolve(view());
    await vi.waitFor(() => {
      expect(sync.getState().status).toBe("ready");
    });
    expect(sync.getState().view?.session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "next",
    });
    sync.begin(scope, 2);
    second.resolve(view(2, "new"));
    await vi.waitFor(() => {
      expect(sync.getState().view?.version.sessionRevision).toBe(2);
    });
    sync.receive({
      type: "session.changed",
      version: { ...view().version, sessionRevision: 1 },
    });
    expect(sync.getState().view?.version.sessionRevision).toBe(2);
    sync.dispose();
  });
  it("uses four attempts even after repeated hello/gap and releases timers on dispose", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise<UiSessionView>(() => undefined));
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    for (let index = 0; index < 20; index++) sync.begin(scope, 1);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(query).toHaveBeenCalledTimes(4);
    expect(sync.getState().status).toBe("error");
    sync.begin(scope, 1);
    expect(query).toHaveBeenCalledTimes(4);
    sync.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards stale A→B→A responses and preserves a failed baseline for display", async () => {
    const old = deferred<UiSessionView>();
    const sync = createSessionSync({
      query: vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(view(5, "fresh")),
    });
    sync.begin(scope, 1);
    await flushPromises();
    sync.begin({ ...scope, sessionId: "b" }, 1);
    sync.begin(scope, 1);
    await vi.waitFor(() => {
      expect(sync.getState().status).toBe("ready");
    });
    old.resolve(view());
    await Promise.resolve();
    expect(sync.getState().view?.version.sessionRevision).toBe(5);
    sync.disconnect();
    expect(sync.getState().view?.session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "fresh",
    });
    expect(sync.getState().status).toBe("syncing");
    sync.dispose();
  });
});

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

describe("recovery interleavings found during independent review", () => {
  it("bounds rapid rebuilt-generation failures and allows explicit retry", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const query = vi.fn(() =>
      Promise.resolve({
        ...view(),
        version: {
          ...view().version,
          viewGeneration: `g${String(++generation)}`,
        },
      }),
    );
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      for (let index = 0; index < 100; index++) {
        sync.receive({
          type: "session.unavailable",
          ...scope,
          viewGeneration: sync.getState().view?.version.viewGeneration,
          reason: "persistent observer failure",
        });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(sync.getState().status).toBe("error");
      expect(query).toHaveBeenCalledTimes(4);
      sync.begin(scope, 1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(query).toHaveBeenCalledTimes(4);
      sync.retry();
      await flushPromises();
      expect(sync.getState().status).toBe("ready");
      expect(query).toHaveBeenCalledTimes(5);
    } finally {
      sync.dispose();
    }
  });

  it("retains the short-failure budget across repeated hello and reconnect", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const query = vi.fn(() =>
      Promise.resolve({
        ...view(),
        version: {
          ...view().version,
          viewGeneration: `g${String(++generation)}`,
        },
      }),
    );
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      for (let index = 1; index <= 4; index++) {
        sync.receive({
          type: "session.unavailable",
          ...scope,
          viewGeneration: sync.getState().view?.version.viewGeneration,
          reason: "persistent",
        });
        for (let hello = 0; hello < 5; hello++) sync.begin(scope, index);
        sync.disconnect();
        sync.begin(scope, index + 1);
        await flushPromises();
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(sync.getState().status).toBe("error");
      const attempts = query.mock.calls.length;
      for (let index = 6; index < 20; index++) {
        sync.disconnect();
        sync.begin(scope, index);
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(query).toHaveBeenCalledTimes(attempts);
      expect(sync.getState().status).toBe("error");
    } finally {
      sync.dispose();
    }
  });

  it("bounds rapid revision-gap recovery even when every baseline query succeeds", async () => {
    vi.useFakeTimers();
    let revision = 0;
    const query = vi.fn(() => Promise.resolve(view(revision)));
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      for (let index = 0; index < 10; index++) {
        revision += 2;
        sync.receive({
          type: "session.changed",
          version: view(revision).version,
        });
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(sync.getState().status).toBe("error");
      expect(query).toHaveBeenCalledTimes(4);
    } finally {
      sync.dispose();
    }
  });

  it("gives each stable successful recovery a new bounded cycle on one connection", async () => {
    vi.useFakeTimers();
    let generation = 0;
    const query = vi.fn(() =>
      Promise.resolve({
        ...view(1),
        version: {
          ...view(1).version,
          viewGeneration: `generation-${String(generation)}`,
        },
      }),
    );
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, "in-process");
      await flushPromises();
      for (generation = 1; generation <= 6; generation++) {
        await vi.advanceTimersByTimeAsync(1_000);
        sync.receive({
          type: "session.changed",
          version: {
            ...view(1).version,
            viewGeneration: `generation-${String(generation)}`,
          },
        });
        await flushPromises();
        expect(sync.getState().status).toBe("ready");
        expect(sync.getState().attempts).toBe(0);
      }
      expect(query).toHaveBeenCalledTimes(7);
    } finally {
      sync.dispose();
    }
  });

  it("keeps an unsuccessful cycle bounded despite repeated hello and unavailable", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => Promise.reject(new Error("offline")));
    const sync = createSessionSync({ query, limits: { retryDelaysMs: [10] } });
    try {
      sync.begin(scope, 1);
      for (let index = 0; index < 50; index++) {
        sync.begin(scope, 1);
        sync.receive({
          type: "session.unavailable",
          ...scope,
          reason: "broken",
        });
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(query).toHaveBeenCalledTimes(4);
      expect(sync.getState().status).toBe("error");
      expect(sync.getState().attempts).toBe(4);
    } finally {
      sync.dispose();
    }
  });

  it("recovers an unseen generation failure instead of treating every different ID as stale", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValue({
        ...view(),
        version: { ...view().version, viewGeneration: "rebuilt" },
      });
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      sync.receive({
        type: "session.unavailable",
        ...scope,
        reason: "new failure",
        viewGeneration: "unseen",
      });
      await flushPromises();
      expect(query).toHaveBeenCalledTimes(2);
      expect(sync.getState().view?.version.viewGeneration).toBe("rebuilt");
    } finally {
      sync.dispose();
    }
  });

  it("does not abort an in-flight baseline under repeated unavailable notifications", async () => {
    vi.useFakeTimers();
    const pending = deferred<UiSessionView>();
    const signals: AbortSignal[] = [];
    const query = vi.fn((_scope, signal: AbortSignal) => {
      signals.push(signal);
      return pending.promise;
    });
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      for (let index = 0; index < 20; index++) {
        sync.receive({
          type: "session.unavailable",
          ...scope,
          reason: "broken",
        });
        sync.begin(scope, 1);
        await vi.advanceTimersByTimeAsync(15);
      }
      expect(query).toHaveBeenCalledTimes(1);
      expect(signals[0]?.aborted).toBe(false);
      pending.resolve(view());
      await flushPromises();
      expect(sync.getState().status).toBe("ready");
    } finally {
      sync.dispose();
    }
  });

  it("finishes an in-flight query but rejects a baseline invalidated while it was pending", async () => {
    vi.useFakeTimers();
    const pending = deferred<UiSessionView>();
    const signals: AbortSignal[] = [];
    const query = vi.fn((_scope, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1
        ? pending.promise
        : Promise.resolve({
            ...view(),
            version: { ...view().version, viewGeneration: "replacement" },
          });
    });
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      sync.receive({
        type: "session.unavailable",
        ...scope,
        reason: "broken",
        viewGeneration: "view",
      });
      expect(signals[0]?.aborted).toBe(false);
      pending.resolve(view());
      await flushPromises();
      expect(sync.getState().status).toBe("syncing");
      await vi.advanceTimersByTimeAsync(100);
      expect(sync.getState().status).toBe("ready");
      expect(sync.getState().view?.version.viewGeneration).toBe("replacement");
    } finally {
      sync.dispose();
    }
  });

  it("ignores an unavailable notification from an already replaced generation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValue({
        ...view(),
        version: { ...view().version, viewGeneration: "replacement" },
      });
    const sync = createSessionSync({ query });
    try {
      sync.begin(scope, 1);
      await flushPromises();
      sync.receive({
        type: "session.unavailable",
        ...scope,
        reason: "broken",
        viewGeneration: "view",
      });
      await flushPromises();
      sync.receive({
        type: "session.unavailable",
        ...scope,
        reason: "late",
        viewGeneration: "view",
      });
      expect(sync.getState().status).toBe("ready");
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      sync.dispose();
    }
  });

  it("does not mark an old baseline ready after a buffered event proves another generation exists", async () => {
    const pending = deferred<UiSessionView>();
    const sync = createSessionSync({ query: () => pending.promise });
    sync.begin(scope, 1);
    await flushPromises();
    sync.receive({
      type: "session.changed",
      version: {
        ...view().version,
        viewGeneration: "replacement",
        sessionRevision: 1,
      },
      messages: view(1, "replacement text").session.messages,
    });
    pending.resolve(view(10, "obsolete text"));
    await flushPromises();
    try {
      expect(sync.getState().status).not.toBe("ready");
      expect(sync.getState().view?.version.viewGeneration).not.toBe("view");
    } finally {
      sync.dispose();
    }
  });

  it("revalidates every hello on the same connection without resetting the query budget", async () => {
    const query = vi.fn(() => Promise.resolve(view()));
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    await flushPromises();
    expect(sync.getState().status).toBe("ready");
    sync.begin(scope, 1);
    await flushPromises();
    try {
      expect(query).toHaveBeenCalledTimes(2);
      expect(sync.getState().attempts).toBe(0);
    } finally {
      sync.dispose();
    }
  });

  it("does not postpone recovery indefinitely when unavailable notifications keep arriving", async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => Promise.resolve(view()));
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    await flushPromises();
    const unavailable = {
      type: "session.unavailable" as const,
      sessionId: "s",
      runtimeEpoch: "epoch",
      reason: "projection failed",
    };
    sync.receive(unavailable);
    await vi.advanceTimersByTimeAsync(50);
    sync.receive(unavailable);
    await vi.advanceTimersByTimeAsync(100);
    try {
      // Legacy notifications lack generation identity; once recovery succeeds,
      // the next notification is a distinct recovery cycle.
      expect(query).toHaveBeenCalledTimes(3);
      expect(sync.getState().status).toBe("ready");
      expect(sync.getState().attempts).toBe(0);
    } finally {
      sync.dispose();
    }
  });

  it("never starts a queued query after synchronous dispose", async () => {
    const query = vi.fn(() => Promise.resolve(view()));
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    sync.dispose();
    await flushPromises();
    expect(query).not.toHaveBeenCalled();
  });

  it("aborts an overflowed baseline and never installs its late response", async () => {
    vi.useFakeTimers();
    const old = deferred<UiSessionView>();
    const signals: AbortSignal[] = [];
    const sync = createSessionSync({
      limits: { maxBufferedEvents: 1 },
      query: (_scope, signal) => {
        signals.push(signal);
        return old.promise;
      },
    });
    sync.begin(scope, 1);
    await flushPromises();
    for (const revision of [1, 2])
      sync.receive({
        type: "session.changed",
        version: view(revision).version,
      });
    old.resolve(view(2, "late"));
    await flushPromises();
    expect(signals[0]?.aborted).toBe(true);
    expect(sync.getState().status).toBe("syncing");
    expect(sync.getState().view).toBeUndefined();
    sync.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["count", "utf8-bytes"] as const)(
    "enforces the production %s buffer limit without truncating a message",
    async (limit) => {
      vi.useFakeTimers();
      const pending = deferred<UiSessionView>();
      const signals: AbortSignal[] = [];
      const query = vi.fn((_scope, signal: AbortSignal) => {
        signals.push(signal);
        return pending.promise;
      });
      const sync = createSessionSync({ query });
      sync.begin(scope, 1);
      await flushPromises();
      if (limit === "count") {
        for (let revision = 1; revision <= 1025; revision++)
          sync.receive({
            type: "session.changed",
            version: view(revision).version,
          });
      } else
        sync.receive({
          type: "session.changed",
          version: view(1).version,
          messages: view(1, "中".repeat(3 * 1024 * 1024)).session.messages,
        });
      expect(signals[0]?.aborted).toBe(true);
      pending.resolve(view(0, "old"));
      await flushPromises();
      expect(sync.getState().view).toBeUndefined();
      expect(sync.getState().status).toBe("syncing");
      sync.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("recovers a gap from an authoritative newer baseline and ignores duplicate older events", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view(3, "complete"));
    const sync = createSessionSync({ query });
    sync.begin(scope, 1);
    await flushPromises();
    sync.receive({
      type: "session.changed",
      version: view(3).version,
      messages: view(3, "complete").session.messages,
    });
    sync.receive({
      type: "session.changed",
      version: view(1).version,
      messages: view(1, "short").session.messages,
    });
    await flushPromises();
    expect(sync.getState().status).toBe("ready");
    expect(sync.getState().view?.session.messages[0]?.parts[0]).toMatchObject({
      text: "complete",
    });
    sync.dispose();
  });
});
