import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
} from "../../../../../packages/ohbaby-agent/src/services/database/index.js";
import { DatabasePromptSubmissionStore } from "../../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/database-store.js";
import { fixture } from "./new-session.test-support.js";

afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("New session real persistent REST regression", () => {
  it("retrying New on the same scope recovers failed chat sync without replacing the session", async () => {
    const f = await fixture();
    try {
      const broken = vi
        .spyOn(
          f.backend as Required<Pick<typeof f.backend, "getSessionView">>,
          "getSessionView",
        )
        .mockRejectedValue(new Error("temporary view failure"));
      await f.runtime.createSession();
      await vi.waitFor(
        () => {
          expect(f.runtime.store.getSnapshot().sessionSync.status).toBe(
            "error",
          );
        },
        { timeout: 5000 },
      );
      const selected = await f.runtime.client?.getSelectedSessionId();
      const count = f.count();
      broken.mockRestore();
      await f.runtime.createSession();
      await vi.waitFor(() => {
        expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
      });
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(selected);
      expect(f.count()).toBe(count);
    } finally {
      await f.dispose();
    }
  });

  it("refreshing an empty session releases its old SSE occupancy before routing retention expires", async () => {
    const f = await fixture();
    const reloaded = f.makeRuntime("web-regression-reloaded");
    try {
      await f.runtime.createSession();
      const empty = await f.runtime.client?.getSelectedSessionId();
      const count = f.count();
      await f.runtime.dispose();
      await reloaded.ready;
      await reloaded.createSession();
      expect(await reloaded.client?.getSelectedSessionId()).toBe(empty);
      expect(f.count()).toBe(count);
    } finally {
      await reloaded.dispose();
      await f.dispose();
    }
  });

  it("one UI action issues one creation request and creates only one session", async () => {
    const f = await fixture();
    try {
      const before = f.count();
      await f.runtime.createSession();
      expect(
        f.requests.filter((path) => path.endsWith("/sessions")),
      ).toHaveLength(1);
      expect(f.count()).toBe(before + 1);
    } finally {
      await f.dispose();
    }
  });
  it("concurrent New session on the same empty selection creates no discarded rows", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const first = await f.runtime.client?.getSelectedSessionId();
      const before = f.count();
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => f.runtime.createSession()),
      );
      expect
        .soft(
          results.map((result) =>
            result.status === "rejected"
              ? String(result.reason)
              : result.status,
          ),
        )
        .toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
      expect.soft(await f.runtime.client?.getSelectedSessionId()).toBe(first);
      expect.soft(f.count()).toBe(before);
    } finally {
      await f.dispose();
    }
  });
  it("a used nonempty session creates a fresh empty session, then reuses it", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const used = await f.runtime.client?.getSelectedSessionId();
      if (!used) throw new Error("missing selection");
      await f.backend.submitPromptAndWait("hello", { sessionId: used });
      const messages =
        getDatabase()
          .prepare<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM message WHERE session_id = ?")
          .get(used)?.count ?? 0;
      expect(messages).toBeGreaterThan(0);
      const before = f.count();
      await f.runtime.createSession();
      const empty = await f.runtime.client?.getSelectedSessionId();
      expect(empty).not.toBe(used);
      expect(f.count()).toBe(before + 1);
      await f.runtime.createSession();
      expect.soft(await f.runtime.client?.getSelectedSessionId()).toBe(empty);
      expect.soft(f.count()).toBe(before + 1);
    } finally {
      await f.dispose();
    }
  });
  it("reusing the current empty session keeps the ready conversation without a recovery pass", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      await vi.waitFor(() => {
        expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
      });
      const statuses: string[] = [];
      const unsubscribe = f.runtime.store.subscribe(() => {
        statuses.push(f.runtime.store.getSnapshot().sessionSync.status);
      });
      try {
        await f.runtime.createSession();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      } finally {
        unsubscribe();
      }
      expect(statuses).not.toContain("syncing");
      expect(f.runtime.store.getSnapshot().sessionSync.status).toBe("ready");
      expect(f.runtime.store.getSnapshot().permissionSync.status).toBe("ready");
    } finally {
      await f.dispose();
    }
  });
  it("after switching to a used session, New session reuses the project's inactive empty session", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const used = await f.runtime.client?.getSelectedSessionId();
      if (!used) throw new Error("missing selection");
      await f.backend.submitPromptAndWait("hello", { sessionId: used });
      await f.runtime.createSession();
      const empty = await f.runtime.client?.getSelectedSessionId();
      expect(empty).not.toBe(used);
      const before = f.count();
      for (let round = 0; round < 3; round += 1) {
        await f.runtime.selectSession(used);
        expect(await f.runtime.client?.getSelectedSessionId()).toBe(used);
        await f.runtime.createSession();
        expect(await f.runtime.client?.getSelectedSessionId()).toBe(empty);
        expect(f.count()).toBe(before);
      }
    } finally {
      await f.dispose();
    }
  });
  it("fresh clients do not reuse or select another client's empty session", async () => {
    const f = await fixture();
    const other = f.makeRuntime("other-client");
    try {
      await other.ready;
      await f.runtime.createSession();
      const first = await f.runtime.client?.getSelectedSessionId();
      await other.createSession();
      const second = await other.client?.getSelectedSessionId();
      expect(second).not.toBe(first);
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(first);
      expect(f.count()).toBe(2);
      await Promise.all([f.runtime.createSession(), other.createSession()]);
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(first);
      expect(await other.client?.getSelectedSessionId()).toBe(second);
      expect(f.count()).toBe(2);
      expect(await f.backend.getSelectedSessionId()).toBeNull();
    } finally {
      await other.dispose();
      await f.dispose();
    }
  });
  it("repeated New session reuses the current empty session and does not grow SQLite rows", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const first = await f.runtime.client?.getSelectedSessionId();
      const before = f.count();
      const binding = f.runtime.store.getSnapshot().permissionSync.binding;
      await f.runtime.createSession();
      expect(f.runtime.store.getSnapshot().permissionSync.binding).toEqual(
        binding,
      );
      const second = await f.runtime.client?.getSelectedSessionId();
      expect.soft(second).toBe(first);
      expect.soft(f.count()).toBe(before);
      expect(
        f.requests.filter((path) => path.endsWith("/sessions")),
      ).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });
  it("coalesces concurrent first creates without a selected session", async () => {
    const f = await fixture();
    try {
      await Promise.all(
        Array.from({ length: 5 }, () => f.runtime.createSession()),
      );
      expect(f.count()).toBe(1);
      expect(await f.runtime.client?.getSelectedSessionId()).toBeTruthy();
      expect(await f.backend.getSelectedSessionId()).toBeNull();
    } finally {
      await f.dispose();
    }
  });

  it("coalesces concurrent creation from a used session into one fresh empty session", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const used = await f.runtime.client?.getSelectedSessionId();
      if (!used) throw new Error("missing selected session");
      await f.backend.submitPromptAndWait("hello", { sessionId: used });
      const before = f.count();
      await Promise.all(
        Array.from({ length: 4 }, () => f.runtime.createSession()),
      );
      expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(used);
      expect(f.count()).toBe(before + 1);
    } finally {
      await f.dispose();
    }
  });

  it.each(["foreign-project", "subagent", "archived", "message-stat"])(
    "does not reuse an explicit %s metadata candidate",
    async (kind) => {
      const f = await fixture();
      try {
        const first = await f.backend.createSession();
        const db = getDatabase();
        if (kind === "foreign-project")
          db.prepare("UPDATE session SET project_root = ? WHERE id = ?").run(
            "/another-project",
            first.id,
          );
        if (kind === "subagent")
          db.prepare("UPDATE session SET data = ? WHERE id = ?").run(
            JSON.stringify({ isSubagent: true }),
            first.id,
          );
        if (kind === "archived")
          db.prepare("UPDATE session SET status = 'archived' WHERE id = ?").run(
            first.id,
          );
        if (kind === "message-stat")
          db.prepare("UPDATE session SET message_count = 1 WHERE id = ?").run(
            first.id,
          );
        expect(
          (await f.backend.createSession({ reuseSessionId: first.id })).id,
        ).not.toBe(first.id);
      } finally {
        await f.dispose();
      }
    },
  );

  it("does not treat a zero-part historical assistant message as empty", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const id = await f.runtime.client?.getSelectedSessionId();
      if (!id) throw new Error("missing selected session");
      getDatabase()
        .prepare(
          "INSERT INTO message (id,session_id,role,created_at,updated_at,data) VALUES (?,?, 'assistant',1,1,'{}')",
        )
        .run("historical-message", id);
      expect(
        getDatabase()
          .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM part")
          .get()?.count,
      ).toBe(0);
      await f.runtime.createSession();
      expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(id);
      expect(f.count()).toBe(2);
    } finally {
      await f.dispose();
    }
  });

  it.each(["pending", "running", "succeeded"])(
    "does not reuse a session with a %s run and no messages",
    async (status) => {
      const f = await fixture();
      try {
        await f.runtime.createSession();
        const id = await f.runtime.client?.getSelectedSessionId();
        if (!id) throw new Error("missing selected session");
        getDatabase()
          .prepare(
            "INSERT INTO run_ledger (run_id,session_id,trigger,status,created_at) VALUES (?,?, 'user',?,1)",
          )
          .run("existing-run", id, status);
        await f.runtime.createSession();
        expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(id);
        expect(f.count()).toBe(2);
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["queued", "starting", "running"])(
    "does not reuse a session with a %s prompt before any message or run exists",
    async (status) => {
      const f = await fixture();
      try {
        await f.runtime.createSession();
        const id = await f.runtime.client?.getSelectedSessionId();
        if (!id) throw new Error("missing selected session");
        getDatabase()
          .prepare(
            "INSERT INTO prompt_submission (prompt_id,client_request_id,scope_key,session_id,user_message_id,text,status,created_at,updated_at) VALUES ('queued','request',?,?,'future-message','hello',?,1,1)",
          )
          .run(f.workdir, id, status);
        await f.runtime.createSession();
        expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(id);
        expect(f.count()).toBe(2);
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(["cancelled", "interrupted"])(
    "does not reuse a %s prompt accepted before execution, then reuses the fresh session",
    async (terminal) => {
      const f = await fixture();
      try {
        await f.runtime.createSession();
        const id = await f.runtime.client?.getSelectedSessionId();
        if (!id) throw new Error("missing selected session");
        const store = new DatabasePromptSubmissionStore();
        await store.accept({
          promptId: "before-execution",
          clientRequestId: "before-execution-request",
          scopeKey: f.workdir,
          sessionId: id,
          userMessageId: "not-yet-created",
          text: "queued",
          maxQueuedPrompts: 100,
        });
        if (terminal === "cancelled") {
          await f.backend.cancelQueuedPrompt({ promptId: "before-execution" });
        } else {
          await store.claim("before-execution");
          await store.recoverInterrupted(f.workdir);
        }
        expect((await store.get("before-execution"))?.status).toBe(terminal);
        expect(await store.listForSession(f.workdir, id)).toEqual([]);
        for (const table of ["message", "run_ledger"]) {
          expect(
            getDatabase()
              .prepare<{
                count: number;
              }>(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
              .get(id)?.count,
          ).toBe(0);
        }
        await f.runtime.createSession();
        const fresh = await f.runtime.client?.getSelectedSessionId();
        expect(fresh).not.toBe(id);
        expect(f.count()).toBe(2);
        await f.runtime.createSession();
        expect(await f.runtime.client?.getSelectedSessionId()).toBe(fresh);
        expect(f.count()).toBe(2);
      } finally {
        await f.dispose();
      }
    },
  );

  it("propagates an authoritative message read failure without treating it as empty, then permits retry", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const id = await f.runtime.client?.getSelectedSessionId();
      if (!id) throw new Error("missing selected session");
      const db = getDatabase();
      const prepare = db.prepare.bind(db);
      const readFailure = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.startsWith("SELECT * FROM message WHERE"))
          throw new Error("fixture message read unavailable");
        return prepare(sql);
      });
      try {
        await expect(
          f.backend.createSession({ reuseSessionId: id }),
        ).rejects.toThrow("fixture message read unavailable");
        expect(f.count()).toBe(1);
      } finally {
        readFailure.mockRestore();
      }
      await f.runtime.createSession();
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(id);
      expect(f.count()).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it("does not classify a failed durable prompt existence read as empty, and permits retry", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const id = await f.runtime.client?.getSelectedSessionId();
      const read = vi
        .spyOn(DatabasePromptSubmissionStore.prototype, "hasForSession")
        .mockRejectedValueOnce(
          new Error("fixture prompt existence unavailable"),
        );
      try {
        await expect(f.runtime.createSession()).rejects.toThrow(
          "fixture prompt existence unavailable",
        );
        expect(read).toHaveBeenCalledWith(f.workdir, id);
        expect(f.count()).toBe(1);
        expect(await f.runtime.client?.getSelectedSessionId()).toBe(id);
      } finally {
        read.mockRestore();
      }
      await f.runtime.createSession();
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(id);
      expect(f.count()).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it("clears a failed flight so creation can be retried", async () => {
    const f = await fixture();
    try {
      vi.spyOn(f.backend, "createSession").mockRejectedValueOnce(
        new Error("fixture read unavailable"),
      );
      await expect(f.runtime.createSession()).rejects.toThrow(
        "fixture read unavailable",
      );
      expect(f.count()).toBe(0);
      await f.runtime.createSession();
      expect(f.count()).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it("separates flights across explicit selection and keeps the newer flight when the old one fails", async () => {
    const f = await fixture();
    const oldGate = deferred();
    const newGate = deferred();
    const oldEntered = deferred();
    const newEntered = deferred();
    try {
      await f.runtime.createSession();
      const other = await f.backend.createSession();
      const create = f.backend.createSession.bind(f.backend);
      const spy = vi
        .spyOn(f.backend, "createSession")
        .mockImplementationOnce(async (input) => {
          oldEntered.resolve();
          await oldGate.promise;
          return create(input);
        })
        .mockImplementationOnce(async (input) => {
          newEntered.resolve();
          await newGate.promise;
          return create(input);
        });
      const old = f.runtime.createSession();
      const rejectedOld = expect(old).rejects.toThrow(
        "Permission scope has changed",
      );
      await oldEntered.promise;
      await f.runtime.selectSession(other.id);
      const newer = f.runtime.createSession();
      await newEntered.promise;
      oldGate.resolve();
      await rejectedOld;
      const joined = f.runtime.createSession();
      // HTTP entry runs synchronously until its shared backend promise is awaited.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(spy).toHaveBeenCalledTimes(2);
      newGate.resolve();
      await Promise.all([newer, joined]);
      expect(await f.runtime.client?.getSelectedSessionId()).toBe(other.id);
      expect(f.count()).toBe(2);
      expect(await f.backend.getSelectedSessionId()).toBeNull();
    } finally {
      oldGate.resolve();
      newGate.resolve();
      await f.dispose();
    }
  });
});
