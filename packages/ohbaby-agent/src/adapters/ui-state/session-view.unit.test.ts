import { describe, expect, it, vi } from "vitest";
import { SessionViewOwner } from "./session-view.js";
import {
  createSessionSync,
  type UiSessionChangedEvent,
  type UiSessionView,
} from "ohbaby-sdk";
const seed = (sessionId: string): Omit<UiSessionView, "version"> => ({
  session: {
    id: sessionId,
    title: sessionId,
    createdAt: "2026",
    updatedAt: "2026",
    messages: [],
  },
  runs: [],
  prompts: [],
  history: { hasMore: false },
  reasoningMissing: false,
  todo: { status: "ready", value: null },
  goal: { status: "ready", value: null },
  context: { status: "ready", value: null },
});
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("source session commit boundary", () => {
  it("seeds before writes, serializes database and projection, and leaves other sessions free", async () => {
    const blocked = deferred();
    const events: UiSessionChangedEvent[] = [];
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      seed: async (id): Promise<Omit<UiSessionView, "version">> => {
        if (id === "a") await blocked.promise;
        return seed(id);
      },
      publish: (event): void => {
        if (event.type === "session.changed") events.push(event);
      },
    });
    const write = vi.fn();
    const pending = owner.run("a", () => {
      write();
      owner.commit("a", {
        messages: [
          {
            id: "m",
            createdAt: "2026",
            role: "assistant",
            parts: [{ type: "text", text: "one" }],
          },
        ],
      });
      return Promise.resolve();
    });
    await owner.run("b", () => {
      owner.commit("b", { reasoningMissing: true });
      return Promise.resolve();
    });
    expect(owner.read("b").version.sessionRevision).toBe(1);
    expect(write).not.toHaveBeenCalled();
    blocked.resolve();
    await pending;
    const baseline = owner.read("a");
    await owner.run("a", () => {
      owner.commit("a", {
        messages: [
          {
            ...baseline.session.messages[0],
            parts: [{ type: "text", text: "one two" }],
          },
        ],
      });
      return Promise.resolve();
    });
    expect(baseline.version.sessionRevision).toBe(1);
    expect(baseline.session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "one",
    });
    expect(owner.read("a").version.sessionRevision).toBe(2);
    expect(
      events
        .filter((event) => event.version.sessionId === "a")
        .map((event) => event.version.sessionRevision),
    ).toEqual([1, 2]);
  });
  it("does not expose a database write before its projection commit", async () => {
    const blocked = deferred();
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      seed: (id): Promise<Omit<UiSessionView, "version">> =>
        Promise.resolve(seed(id)),
      publish: vi.fn(),
    });
    await owner.initialize("a");
    const pending = owner.run("a", async () => {
      await blocked.promise;
      owner.commit("a", { reasoningMissing: true });
    });
    expect(owner.read("a").reasoningMissing).toBe(false);
    let historyRead = false;
    const history = owner.run("a", () => {
      historyRead = true;
      return Promise.resolve(owner.read("a").version);
    });
    await Promise.resolve();
    expect(historyRead).toBe(false);
    blocked.resolve();
    await pending;
    expect((await history).sessionRevision).toBe(1);
  });
  it("marks failed projection unavailable and rebuilds with a new generation, without changing epoch", async () => {
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      seed: (id): Promise<Omit<UiSessionView, "version">> =>
        Promise.resolve(seed(id)),
      publish: vi.fn(),
    });
    await owner.initialize("a");
    const before = owner.read("a").version;
    owner.markUnavailable("a", new Error("projection failed"));
    expect(() => owner.read("a")).toThrow(/projection failed/);
    await owner.rebuild("a");
    const after = owner.read("a").version;
    expect(after.runtimeEpoch).toBe(before.runtimeEpoch);
    expect(after.viewGeneration).not.toBe(before.viewGeneration);
    expect(after.sessionRevision).toBe(0);
  });
});

it("does not repeat committed business work when delivery and diagnostics fail", async () => {
  const unavailable = vi.fn();
  let failing = true;
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: (id): Promise<Omit<UiSessionView, "version">> =>
      Promise.resolve(seed(id)),
    publish: (event): void => {
      if (event.type === "session.unavailable") unavailable(event);
      if (failing) throw new Error("transport closed");
    },
    onNotificationFailure: (): void => {
      throw new Error("diagnostic also failed");
    },
  });
  await owner.initialize("a");
  await owner.initialize("b");
  const business = vi.fn();
  await owner.run("a", () => {
    business();
    owner.commit("a", { reasoningMissing: true });
    return Promise.resolve();
  });
  expect(business).toHaveBeenCalledOnce();
  expect(() => owner.read("a")).toThrow("transport closed");
  expect(owner.read("b").version.sessionRevision).toBe(0);
  expect(unavailable).toHaveBeenCalledOnce();
  failing = false;
  await owner.rebuild("a");
  expect(owner.read("a").version.runtimeEpoch).toBe("epoch");
});

describe("explicit source rebuild attempts", () => {
  it("recovers more than four independent failures without a lifetime retry cap", async () => {
    const load = vi.fn((id: string) => Promise.resolve(seed(id)));
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      seed: load,
      publish: vi.fn(),
    });
    await owner.initialize("a");
    const generations = new Set([owner.read("a").version.viewGeneration]);
    for (let attempt = 0; attempt < 6; attempt++) {
      owner.markUnavailable("a", new Error("transient projection failure"));
      await owner.rebuild("a");
      generations.add(owner.read("a").version.viewGeneration);
    }
    expect(generations.size).toBe(7);
    expect(load).toHaveBeenCalledTimes(7);
    owner.dispose();
  });

  it("coalesces concurrent rebuilds into one seed and generation", async () => {
    const blocked = deferred();
    const entered = deferred();
    let calls = 0;
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      publish: vi.fn(),
      seed: async (id): Promise<Omit<UiSessionView, "version">> => {
        if (++calls === 2) {
          entered.resolve();
          await blocked.promise;
        }
        return seed(id);
      },
    });
    await owner.initialize("a");
    owner.markUnavailable("a", new Error("projection failed"));
    const first = owner.rebuild("a");
    const second = owner.rebuild("a");
    await entered.promise;
    expect(second).toBe(first);
    blocked.resolve();
    const views = await Promise.all([
      first.then(() => owner.read("a").version),
      second.then(() => owner.read("a").version),
    ]);
    expect(calls).toBe(2);
    expect(views[0]).toEqual(views[1]);
    owner.dispose();
  });

  it("still blocks business when the first initialization fails", async () => {
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      publish: vi.fn(),
      seed: (): Promise<never> =>
        Promise.reject(new Error("first seed failed")),
    });
    const business = vi.fn(() => Promise.resolve());
    await expect(owner.run("a", business)).rejects.toThrow("first seed failed");
    expect(business).not.toHaveBeenCalled();
    owner.dispose();
  });

  it("waits for failed rebuild then permits committed business and a later explicit recovery", async () => {
    const failedSeed = deferred();
    const successfulSeed = deferred();
    let calls = 0;
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      publish: vi.fn(),
      seed: async (id): Promise<Omit<UiSessionView, "version">> => {
        if (++calls === 2) {
          await failedSeed.promise;
          throw new Error("seed unavailable");
        }
        if (calls === 3) await successfulSeed.promise;
        return seed(id);
      },
    });
    await owner.initialize("a");
    owner.markUnavailable("a", new Error("projection failed"));
    const failedAttempt = owner.rebuild("a");
    const blockedWrite = vi.fn(() => Promise.resolve());
    const failedWrite = owner.run("a", blockedWrite);
    const failedAssertions = Promise.all([
      expect(failedAttempt).rejects.toThrow("seed unavailable"),
      expect(failedWrite).resolves.toBeUndefined(),
    ]);
    await Promise.resolve();
    expect(blockedWrite).not.toHaveBeenCalled();
    failedSeed.resolve();
    await failedAssertions;
    expect(blockedWrite).toHaveBeenCalledOnce();
    expect(() => owner.read("a")).toThrow("seed unavailable");
    const newAttempt = owner.rebuild("a");
    const committed = vi.fn(() => {
      owner.commit("a", { reasoningMissing: true });
      return Promise.resolve();
    });
    const pendingWrite = owner.run("a", committed);
    await Promise.resolve();
    expect(committed).not.toHaveBeenCalled();
    successfulSeed.resolve();
    await Promise.all([newAttempt, pendingWrite]);
    expect(committed).toHaveBeenCalledOnce();
    expect(owner.read("a").version.sessionRevision).toBe(1);
    expect(calls).toBe(3);
    owner.dispose();
  });
});

it("publishes unavailable once per failed generation while business keeps advancing", async () => {
  const publish = vi.fn();
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: (id): Promise<Omit<UiSessionView, "version">> =>
      Promise.resolve(seed(id)),
    publish,
  });
  await owner.initialize("a");
  const firstGeneration = owner.read("a").version.viewGeneration;
  for (let index = 0; index < 100; index++)
    owner.markUnavailable("a", new Error("projection failed"));
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "session.unavailable",
      viewGeneration: firstGeneration,
    }),
  );
  await owner.rebuild("a");
  const nextGeneration = owner.read("a").version.viewGeneration;
  owner.markUnavailable("a", new Error("failed again"));
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ viewGeneration: nextGeneration }),
  );
  owner.dispose();
});

it("retries first seed after a rejected initialization without executing business early", async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("first seed failed"))
    .mockImplementation((id: string) => Promise.resolve(seed(id)));
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: load,
    publish: vi.fn(),
  });
  const business = vi.fn(() => {
    owner.commit("a", { reasoningMissing: true });
    return Promise.resolve();
  });
  await expect(owner.run("a", business)).rejects.toThrow("first seed failed");
  expect(business).not.toHaveBeenCalled();
  await owner.run("a", business);
  expect(load).toHaveBeenCalledTimes(2);
  expect(business).toHaveBeenCalledOnce();
  expect(owner.read("a").reasoningMissing).toBe(true);
  owner.dispose();
});

it("serializes control writes after a failed first seed and before an explicit rebuild", async () => {
  const blocked = deferred();
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("first seed failed"))
    .mockImplementation((id: string) => Promise.resolve(seed(id)));
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: load,
    publish: vi.fn(),
  });
  await expect(owner.initialize("a")).rejects.toThrow("first seed failed");
  const control = vi.fn(async () => {
    await blocked.promise;
  });
  const pendingControl = owner.runControl("a", control);
  const rebuilt = owner.rebuild("a");
  await vi.waitFor(() => {
    expect(control).toHaveBeenCalledOnce();
  });
  expect(load).toHaveBeenCalledTimes(1);
  blocked.resolve();
  await Promise.all([pendingControl, rebuilt]);
  expect(load).toHaveBeenCalledTimes(2);
  expect(owner.read("a").version.sessionRevision).toBe(0);
  owner.dispose();
});

it("waits for an already pending initial seed before a control write", async () => {
  const blocked = deferred();
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    publish: vi.fn(),
    seed: async (id): Promise<Omit<UiSessionView, "version">> => {
      await blocked.promise;
      return seed(id);
    },
  });
  const initializing = owner.initialize("a");
  const control = vi.fn(() => Promise.resolve());
  const pending = owner.runControl("a", control);
  await Promise.resolve();
  expect(control).not.toHaveBeenCalled();
  blocked.resolve();
  await Promise.all([initializing, pending]);
  expect(control).toHaveBeenCalledOnce();
  owner.dispose();
});

it("streams long text into a slow baseline with bounded incremental transport", async () => {
  const blocked = deferred();
  let initial: UiSessionView;
  const sync = createSessionSync({
    query: async () => {
      await blocked.promise;
      return initial;
    },
  });
  let bytes = 0;
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: (id): Promise<Omit<UiSessionView, "version">> =>
      Promise.resolve({
        ...seed(id),
        session: {
          ...seed(id).session,
          messages: [
            {
              id: "m",
              role: "assistant",
              createdAt: "2026",
              status: "streaming",
              parts: [{ id: "p", type: "text", text: "x".repeat(300_000) }],
            },
          ],
        },
      }),
    publish: (event): void => {
      bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
      sync.receive(event);
    },
  });
  try {
    await owner.initialize("a");
    initial = owner.read("a");
    sync.begin({ sessionId: "a", runtimeEpoch: "epoch" }, 1);
    for (let index = 1; index <= 100; index++)
      owner.commit("a", {
        messages: [
          {
            ...initial.session.messages[0],
            parts: [
              {
                id: "p",
                type: "text",
                text: "x".repeat(300_000) + "中😀".repeat(index),
              },
            ],
          },
        ],
      });
    expect(
      bytes,
      `100 token events transferred ${String(bytes)} bytes`,
    ).toBeLessThan(100_000);
    expect(bytes).toBe(25_992);
    blocked.resolve();
    await vi.waitFor(() => {
      expect(sync.getState().status).toBe("ready");
    });
    expect(sync.getState().view).toEqual(owner.read("a"));
  } finally {
    blocked.resolve();
    sync.dispose();
    owner.dispose();
  }
});

it.each([
  "metadata",
  "terminal",
  "part-state",
  "rewrite",
  "reorder",
  "missing-id",
])("keeps full message transport for a %s change", async (kind) => {
  const publish = vi.fn();
  const message = {
    id: "m",
    role: "assistant" as const,
    createdAt: "2026",
    status: "streaming" as const,
    parts: [
      { id: "p", type: "text" as const, text: "start" },
      {
        id: "r",
        type: "reasoning" as const,
        text: "why",
        saveState: "pending" as const,
      },
    ],
  };
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    publish,
    seed: (id): Promise<Omit<UiSessionView, "version">> =>
      Promise.resolve({
        ...seed(id),
        session: { ...seed(id).session, messages: [message] },
      }),
  });
  await owner.initialize("a");
  const next: typeof message | UiSessionView["session"]["messages"][number] = {
    ...message,
    ...(kind === "metadata" ? { updatedAt: "new" } : {}),
    ...(kind === "terminal" ? { status: "completed" as const } : {}),
    parts:
      kind === "reorder"
        ? [...message.parts].reverse()
        : [
            {
              ...message.parts[0],
              text: kind === "rewrite" ? "changed" : "start next",
              ...(kind === "missing-id" ? { id: undefined } : {}),
            },
            {
              ...message.parts[1],
              ...(kind === "part-state" ? { saveState: "saved" as const } : {}),
            },
          ],
  };
  owner.commit("a", { messages: [next] });
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ messages: [next] }),
  );
  expect(publish.mock.calls[0]?.[0]).not.toHaveProperty("textAppends");
  expect(owner.read("a").session.messages).toEqual([next]);
  owner.dispose();
});

it("recovers long reasoning appends followed by the full saved handoff during a slow baseline", async () => {
  const blocked = deferred();
  let initial: UiSessionView;
  const events: UiSessionChangedEvent[] = [];
  const sync = createSessionSync({
    query: async () => {
      await blocked.promise;
      return initial;
    },
  });
  const owner = new SessionViewOwner({
    runtimeEpoch: "epoch",
    seed: (id): Promise<Omit<UiSessionView, "version">> =>
      Promise.resolve({
        ...seed(id),
        session: {
          ...seed(id).session,
          messages: [
            {
              id: "m",
              role: "assistant",
              createdAt: "2026",
              runId: "run",
              parts: [
                {
                  id: "reasoning",
                  type: "reasoning",
                  text: "x".repeat(300_000),
                  saveState: "pending",
                },
              ],
            },
          ],
        },
      }),
    publish: (event): void => {
      if (event.type === "session.changed") events.push(event);
      sync.receive(event);
    },
  });
  try {
    await owner.initialize("a");
    initial = owner.read("a");
    sync.begin({ sessionId: "a", runtimeEpoch: "epoch" }, 1);
    for (let index = 1; index <= 100; index++)
      owner.commit("a", {
        messages: [
          {
            ...initial.session.messages[0],
            parts: [
              {
                id: "reasoning",
                type: "reasoning",
                text: "x".repeat(300_000) + "中😀".repeat(index),
                saveState: "pending",
              },
            ],
          },
        ],
      });
    const finalText = "x".repeat(300_000) + "中😀".repeat(100);
    owner.commit("a", {
      messages: [
        {
          ...initial.session.messages[0],
          parts: [
            {
              id: "reasoning",
              type: "reasoning",
              text: finalText,
              saveState: "saved",
              endReason: "normal",
            },
          ],
        },
      ],
    });
    expect(events[0]?.textAppends).toEqual([
      { messageId: "m", partId: "reasoning", offset: 300_000, text: "中😀" },
    ]);
    expect(
      events.slice(0, 100).every((event) => event.messages === undefined),
    ).toBe(true);
    expect(events[100]?.textAppends).toBeUndefined();
    expect(events[100]?.messages?.[0]?.parts[0]).toMatchObject({
      text: finalText,
      saveState: "saved",
      endReason: "normal",
    });
    const bytes = events.reduce(
      (sum, event) =>
        sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    expect(bytes).toBeLessThan(400_000);
    blocked.resolve();
    await vi.waitFor(() => {
      expect(sync.getState().status).toBe("ready");
    });
    expect(sync.getState().view).toEqual(owner.read("a"));
  } finally {
    blocked.resolve();
    sync.dispose();
    owner.dispose();
  }
});
