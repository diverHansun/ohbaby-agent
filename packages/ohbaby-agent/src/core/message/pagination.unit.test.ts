import { describe, expect, it } from "vitest";
import { createInMemoryMessageStore } from "./store.js";
import { messageCursor } from "./pagination.js";
import type { Message } from "./types.js";

function message(
  id: string,
  runId = "run_a",
  contextScopeId?: string,
): Message {
  return {
    id,
    sessionId: "session_1",
    role: "user",
    agent: "default",
    runId,
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    time: { created: 1_000 },
  };
}

describe("in-memory message keyset paging", () => {
  it("pages forward in ascending order across equal timestamps with a bounded cursor", async () => {
    const store = createInMemoryMessageStore();
    for (const id of ["a", "b", "c", "d", "e"])
      await store.insertMessage(message(id));
    const after = messageCursor("session_1", message("a"));
    const first = await store.listPageBySession("session_1", {
      after,
      limit: 2,
    });
    expect(first.messages.map(({ info }) => info.id)).toEqual(["b", "c"]);
    expect(first).toMatchObject({
      firstMessageId: "b",
      lastMessageId: "c",
      hasMore: true,
    });
    const second = await store.listPageBySession("session_1", {
      after: first.nextCursor,
      limit: 2,
    });
    expect(second.messages.map(({ info }) => info.id)).toEqual(["d", "e"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it("rejects conflicting and unauthorized forward cursors for session, scope and run", async () => {
    const store = createInMemoryMessageStore();
    await store.insertMessage(message("a", "run_a", "scope_a"));
    const scope = { contextScopeId: "scope_a" };
    const after = messageCursor("session_1", message("a"), { scope }, "run_a");
    await expect(
      store.listPageByRun("session_1", "run_a", {
        after,
        before: after,
        scope,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_a", { after: "invalid", scope }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("other", "run_a", { after, scope }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_b", { after, scope }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      store.listPageByRun("session_1", "run_a", {
        after,
        scope: { contextScopeId: "scope_b" },
      }),
    ).rejects.toThrow(/cursor/i);
  });
});
