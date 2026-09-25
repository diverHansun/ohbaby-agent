import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DisplayReasoningOwner,
  type ReasoningIdentity,
} from "./display-reasoning.js";

const identity = (
  partId: string,
  sessionId = "session",
): ReasoningIdentity => ({
  sessionId,
  runId: "run",
  messageId: `message-${partId}`,
  partId,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("display reasoning source", () => {
  it("retains pending until the saved commit accepts the exact final value", async () => {
    let releaseSave!: () => void;
    let releaseCommit!: () => void;
    const owner = new DisplayReasoningOwner({
      save: (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
      commit: (change): void | Promise<void> =>
        change.kind === "saved"
          ? new Promise<void>((resolve) => {
              releaseCommit = resolve;
            })
          : undefined,
    });
    await owner.update(identity("p"), "thought");
    await owner.finish("p", "interrupted");
    expect(owner.snapshot("session").parts[0]).toMatchObject({
      text: "thought",
      saveState: "pending",
      endReason: "interrupted",
    });
    expect(owner.pendingPartIds("session")).toEqual(["p"]);
    releaseSave();
    await flush();
    expect(owner.snapshot("session").parts[0]?.saveState).toBe("pending");
    releaseCommit();
    await flush();
    expect(owner.snapshot("session").parts).toEqual([]);
    expect(owner.pendingPartIds("session")).toEqual([]);
  });
  it("retries only twice at 250 and 1000 ms without changing end reason", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const owner = new DisplayReasoningOwner({
      save: (part): Promise<void> => {
        writes.push(part.partId);
        return Promise.reject(new Error("disk"));
      },
    });
    await owner.update(identity("p"), "thought");
    await owner.finish("p", "failed");
    await flush();
    expect(writes).toEqual(["p"]);
    await vi.advanceTimersByTimeAsync(249);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(3);
    await owner.finish("p", "normal");
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(3);
    expect(owner.snapshot("session").parts[0]).toMatchObject({
      endReason: "failed",
      saveState: "failed",
    });
  });
  it("bounds ended values across sessions while a single writer hangs; late success does not resurrect", async () => {
    let release!: () => void;
    let writes = 0;
    const owner = new DisplayReasoningOwner({
      maxBytes: 8,
      maxParts: 2,
      save: (): Promise<void> => {
        writes++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await owner.update(identity("a", "A"), "12345");
    await owner.finish("a", "normal");
    await owner.update(identity("b", "B"), "67890");
    await owner.finish("b", "normal");
    await owner.update(identity("active", "A"), "unbounded-active-thought");
    expect(writes).toBe(1);
    expect(owner.pendingPartIds("A")).toEqual(["active", "a"]);
    expect(owner.snapshot("A")).toMatchObject({
      missingCount: 1,
      parts: [{ partId: "active" }],
    });
    release();
    await flush();
    expect(owner.snapshot("A")).toMatchObject({
      missingCount: 0,
      parts: [{ partId: "active" }],
    });
    expect(writes).toBe(2);
  });
  it("keeps accumulating despite projection failures and saves without surfacing display failures", async () => {
    const saved: string[] = [];
    const owner = new DisplayReasoningOwner({
      commit: (): void | Promise<void> => {
        throw new Error("view");
      },
      save: (part): Promise<void> => {
        saved.push(part.text);
        return Promise.resolve();
      },
    });
    await owner.update(identity("p"), "one");
    await owner.update(identity("p"), "one two");
    await owner.finish("p", "normal");
    await flush();
    expect(saved).toEqual(["one two"]);
    expect(owner.snapshot("session").parts[0]?.text).toBe("one two");
  });
});

describe("display reasoning retention limits", () => {
  it("enforces the shared default 256 segment budget even when the only writer never settles", async () => {
    let writes = 0;
    const owner = new DisplayReasoningOwner({
      save: (): Promise<void> => {
        writes++;
        return new Promise(() => undefined);
      },
    });
    for (let i = 0; i < 257; i++) {
      await owner.update(identity(String(i), String(i % 2)), "x");
      await owner.finish(String(i), "normal");
    }
    expect(writes).toBe(1);
    expect(
      owner.snapshot("0").parts.length + owner.snapshot("1").parts.length,
    ).toBe(256);
    expect(owner.snapshot("0").missingCount).toBe(1);
    expect(owner.snapshot("1").missingCount).toBe(0);
  });
  it("evicts a single ended value over 16 MiB but leaves a generating value untruncated", async () => {
    let writes = 0;
    const owner = new DisplayReasoningOwner({
      save: (): Promise<void> => {
        writes++;
        return Promise.resolve();
      },
    });
    const text = "界".repeat(Math.floor((16 * 1024 * 1024) / 3) + 1);
    await owner.update(identity("large"), text);
    expect(owner.snapshot("session").parts[0]?.text).toBe(text);
    await owner.finish("large", "normal");
    expect(owner.snapshot("session")).toEqual({ parts: [], missingCount: 1 });
    expect(writes).toBe(0);
  });
  it("cancels an evicted retry without resetting the surviving segment budget", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const owner = new DisplayReasoningOwner({
      maxParts: 1,
      save: (part): Promise<void> => {
        writes.push(part.partId);
        return Promise.reject(new Error("disk"));
      },
    });
    await owner.update(identity("old"), "old");
    await owner.finish("old", "interrupted");
    await flush();
    await owner.update(identity("new"), "new");
    await owner.finish("new", "normal");
    await flush();
    await vi.advanceTimersByTimeAsync(1250);
    expect(writes).toEqual(["old", "new", "new", "new"]);
    expect(owner.snapshot("session")).toMatchObject({
      missingCount: 1,
      parts: [{ partId: "new", saveState: "failed" }],
    });
  });
  it("does not invent empty parts or save twice when a segment is finalized repeatedly", async () => {
    const writes: string[] = [];
    const owner = new DisplayReasoningOwner({
      save: (part): Promise<void> => {
        writes.push(part.text);
        return Promise.resolve();
      },
    });
    await owner.update(identity("empty"), "");
    await owner.finish("empty", "normal");
    await owner.update(identity("part"), "real");
    await owner.finish("part", "normal");
    await owner.finish("part", "failed");
    await flush();
    expect(writes).toEqual(["real"]);
    expect(owner.snapshot("session").parts).toEqual([]);
  });
});

it("hands a confirmed database save to explicit projection rebuild without another write", async () => {
  let writes = 0;
  const owner = new DisplayReasoningOwner({
    save: (): Promise<void> => {
      writes++;
      return Promise.resolve();
    },
    commit: (change): void | Promise<void> => {
      if (change.kind === "saved") throw new Error("view unavailable");
    },
  });
  await owner.update(identity("p"), "saved thought");
  await owner.finish("p", "interrupted");
  await flush();
  expect(owner.snapshot("session").parts[0]?.saveState).toBe("pending");
  expect(owner.persistedParts("session")).toEqual([
    expect.objectContaining({
      partId: "p",
      text: "saved thought",
      saveState: "saved",
      endReason: "interrupted",
    }),
  ]);
  owner.acceptPersisted(["p"]);
  expect(owner.snapshot("session").parts).toEqual([]);
  expect(owner.pendingPartIds("session")).toEqual([]);
  expect(writes).toBe(1);
});

it("never describes a confirmed persisted part as lost when its view remains unavailable", async () => {
  const owner = new DisplayReasoningOwner({
    maxParts: 1,
    save: (): Promise<void> => Promise.resolve(),
    commit: (change): void | Promise<void> => {
      if (change.kind === "saved") throw new Error("view unavailable");
    },
  });
  await owner.update(identity("a"), "persisted");
  await owner.finish("a", "normal");
  await flush();
  await owner.update(identity("b"), "next");
  await owner.finish("b", "normal");
  await flush();
  expect(owner.snapshot("session").missingCount).toBe(0);
  expect(owner.snapshot("session").parts).toHaveLength(1);
});

it("disposes retry timers and ignores uncancellable late write callbacks", async () => {
  vi.useFakeTimers();
  let writes = 0;
  const changes: string[] = [];
  const owner = new DisplayReasoningOwner({
    save: (): Promise<void> => {
      writes++;
      return Promise.reject(new Error("disk"));
    },
    commit: (change): void | Promise<void> => {
      changes.push(change.kind);
    },
  });
  await owner.update(identity("a"), "a");
  await owner.finish("a", "normal");
  await flush();
  owner.dispose();
  const before = changes.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(writes).toBe(1);
  expect(changes).toHaveLength(before);
  expect(owner.snapshot("session")).toEqual({ parts: [], missingCount: 0 });

  let release!: () => void;
  const late: string[] = [];
  const hanging = new DisplayReasoningOwner({
    save: (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    commit: (change): void | Promise<void> => {
      late.push(change.kind);
    },
  });
  await hanging.update(identity("b"), "b");
  await hanging.finish("b", "normal");
  hanging.dispose();
  release();
  await flush();
  expect(late).toEqual(["updated", "pending"]);
});

it("accounts for each eviction once when multiple sessions finalize concurrently", async () => {
  const owner = new DisplayReasoningOwner({
    maxParts: 1,
    save: (): Promise<void> => new Promise(() => undefined),
    commit: (): void | Promise<void> => Promise.resolve(),
  });
  const ids = ["a", "b", "c", "d", "e"];
  for (const id of ids) await owner.update(identity(id), id);
  await Promise.all(ids.map((id) => owner.finish(id, "normal")));
  expect(owner.snapshot("session")).toMatchObject({
    missingCount: 4,
    parts: [{ partId: "e" }],
  });
});

it("does not retain a retry timer if eviction happens during the failure commit", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const owner = new DisplayReasoningOwner({
    maxParts: 1,
    save: (part): Promise<void> =>
      part.partId === "a"
        ? Promise.reject(new Error("disk"))
        : new Promise(() => undefined),
    commit: (change): void | Promise<void> =>
      change.kind === "failed"
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined,
  });
  await owner.update(identity("a"), "a");
  await owner.finish("a", "normal");
  await flush();
  await owner.update(identity("b"), "b");
  await owner.finish("b", "normal");
  release();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
});
