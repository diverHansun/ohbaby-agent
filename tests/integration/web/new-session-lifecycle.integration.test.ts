import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRunProcesses } from "../../../apps/ohbaby-web/src/ui/conversation/run-process.js";
import {
  insertMessageRow,
  insertPartRow,
} from "../../../packages/ohbaby-agent/src/core/message/database-store.js";
import { findForkableMainRun } from "../../../packages/ohbaby-agent/src/services/session/copy-history.js";
import {
  commitSessionWorkspaceMove,
  planSessionWorkspaceMove,
} from "ohbaby-agent";
import {
  closeDatabase,
  getDatabase,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import {
  fixture,
  type NewSessionFixture,
} from "../../../apps/ohbaby-web/src/api/daemon/new-session.test-support.js";

const headers = (id: string): Record<string, string> => ({
  authorization: "Bearer fixture-token",
  "content-type": "application/json",
  "x-ohbaby-client-id": id,
});
async function register(
  f: NewSessionFixture,
  id: string,
  sessionId?: string,
): Promise<void> {
  const response = await f.server.app.request("/v1/clients", {
    method: "POST",
    headers: headers(id),
    body: JSON.stringify({
      clientId: id,
      startupIntent: sessionId
        ? { resumeSessionId: sessionId }
        : { startupSessionMode: { type: "fresh" } },
    }),
  });
  expect(response.status).toBe(200);
}
async function create(
  f: NewSessionFixture,
  id: string,
  reuseEmpty = true,
): Promise<{ session: { id: string }; created: boolean }> {
  const response = await f.server.app.request("/v1/sessions", {
    method: "POST",
    headers: headers(id),
    body: JSON.stringify({ reuseEmpty }),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function stream(
  f: NewSessionFixture,
  id: string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await f.server.app.request("/v1/events", {
    headers: headers(id),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  return reader;
}
async function withClock<T>(operation: Promise<T>): Promise<T> {
  let settled = false;
  const observed = operation.finally(() => {
    settled = true;
  });
  void observed.catch(() => undefined);
  await vi.waitFor(() => expect(settled).toBe(true));
  return observed;
}
afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("New session real server lifecycle and SQLite", () => {
  it("matches Web final answers when reading stored main turns with a summary or an empty last step", async () => {
    const f = await fixture();
    try {
      const { id: sessionId } = await f.backend.createSession();
      const send = async (text: string) => {
        const { prompt } = await f.backend.submitPromptAndWait(text, {
          sessionId,
        });
        if (!prompt.runId) throw new Error("Expected a completed main run");
        return prompt.runId;
      };
      const answered = await send("First question");
      const emptyLast = await send("Second question");
      const db = getDatabase();
      const at = Date.now() + 1;
      for (const [id, runId, agent] of [
        ["summary", answered, "context"],
        ["empty", emptyLast, "build"],
      ]) {
        insertMessageRow(db, {
          id,
          sessionId,
          runId,
          agent,
          role: "assistant",
          time: { created: at, completed: at },
        });
      }
      insertPartRow(
        db,
        {
          id: "summary-part",
          messageId: "summary",
          sessionId,
          type: "text",
          orderIndex: 0,
          text: "Internal summary",
          metadata: { kind: "context-summary" },
        },
        at,
      );

      const { messages, prompts, runs } = await f.backend.getSessionHistory({
        sessionId,
      });
      expect(
        messages.some(
          (message) =>
            message.runId === emptyLast &&
            message.parts.some(
              (part) => part.type === "text" && part.text === "done",
            ),
        ),
      ).toBe(true);
      expect(messages.find((message) => message.id === "empty")).toMatchObject({
        role: "assistant",
        runId: emptyLast,
        parts: [],
      });
      expect(messages.find((message) => message.id === "summary")?.role).toBe(
        "system",
      );
      const turns = projectRunProcesses(messages, prompts, sessionId, {}, runs);
      expect(turns.map((turn) => [turn.runId, turn.answerId])).toEqual([
        [answered, expect.any(String)],
        [emptyLast, undefined],
      ]);
      for (const { runId, answerId } of turns)
        expect(findForkableMainRun(db, sessionId, runId)).toBe(
          answerId ? runId : null,
        );
      expect(findForkableMainRun(db, sessionId)).toBe(answered);
    } finally {
      await f.dispose();
    }
  });

  it("forks from unselected roots and preserves typed failures and client binding on both transports", async () => {
    const f = await fixture();
    try {
      const clientId = "web-regression";
      const selected = (await create(f, clientId)).session.id;
      const source = (await f.backend.createSession()).id;
      const turn = await f.backend.submitPromptAndWait("fork this answer", {
        sessionId: source,
      });
      const { runId, userMessageId } = turn.prompt;
      expect(runId).toEqual(expect.any(String));
      const rpc = (method: string, params: unknown[]) =>
        f.server.app.request("/api/rpc", {
          headers: headers(clientId),
          method: "POST",
          body: JSON.stringify({ id: "fork-test", clientId, method, params }),
        });
      const rest = (sessionId: string, target?: Record<string, unknown>) =>
        f.server.app.request(`/v1/sessions/${sessionId}/fork`, {
          headers: headers(clientId),
          method: "POST",
          body: JSON.stringify(target),
        });
      const rpcFork = (sessionId: string, target?: Record<string, unknown>) =>
        rpc("forkSession", [{ sessionId, ...target }]);

      const implicit = await rest(source);
      const first = await implicit.json();
      expect(implicit.status, JSON.stringify(first)).toBe(200);
      expect(first).toEqual({
        sessionId: expect.any(String),
        title: expect.any(String),
      });
      const explicit = await rpcFork(source, { runId });
      expect(explicit.status).toBe(200);
      const second = await explicit.json();
      expect(second).toMatchObject({
        ok: true,
        result: { sessionId: expect.any(String), title: expect.any(String) },
      });
      expect(
        new Set([source, first.sessionId, second.result.sessionId]).size,
      ).toBe(3);
      expect(
        await (await rpc("getSelectedSessionId", [])).json(),
      ).toMatchObject({ result: selected });

      const child = await f.backend.createSession();
      getDatabase()
        .prepare("UPDATE session SET parent_id=? WHERE id=?")
        .run(source, child.id);
      const side = await f.backend.openSideChat({ mainSessionId: source });
      const archived = await f.backend.createSession();
      await f.backend.archiveSession({ sessionId: archived.id });
      const before = f.count();
      const rejected = async (
        id: string,
        target: Record<string, unknown> | undefined,
        status: number,
        code: string,
      ) => {
        for (const call of [rest, rpcFork]) {
          const response = await call(id, target);
          expect(response.status).toBe(status);
          expect(await response.json()).toMatchObject({
            ok: false,
            error: { code },
          });
        }
      };
      await rejected("missing-session", undefined, 404, "SESSION_NOT_FOUND");
      await rejected(child.id, undefined, 409, "SESSION_NOT_ROOT");
      await rejected(side.sideChatId, undefined, 409, "SIDE_CHAT_UNSUPPORTED");
      await rejected(archived.id, undefined, 409, "SESSION_ARCHIVED");
      await rejected(selected, { runId }, 400, "FORK_TARGET_INVALID");
      for (const target of [
        { runId: null },
        { runId: "missing-run" },
        { messageId: userMessageId },
      ])
        await rejected(source, target, 400, "FORK_TARGET_INVALID");
      await commitSessionWorkspaceMove(
        planSessionWorkspaceMove(source, f.workdir + "-moved"),
      );
      await rejected(source, undefined, 409, "SESSION_MOVED");
      expect(f.count()).toBe(before);
    } finally {
      await f.dispose();
    }
  });

  it("exposes side chat lifecycle, typed errors and idempotent close over REST and JSON-RPC", async () => {
    const f = await fixture();
    try {
      const clientId = "web-regression";
      const root = (await create(f, clientId)).session.id;
      type Method = "openSideChat" | "listSideChats" | "closeSideChat";
      const rest = async (method: Method, id: string): Promise<Response> => {
        const closing = method === "closeSideChat";
        return f.server.app.request(
          closing ? `/v1/side-chats/${id}` : `/v1/sessions/${id}/side-chats`,
          {
            headers: headers(clientId),
            method: closing
              ? "DELETE"
              : method === "listSideChats"
                ? "GET"
                : "POST",
          },
        );
      };
      const rpc = async (method: Method, id: string): Promise<Response> =>
        f.server.app.request("/api/rpc", {
          headers: headers(clientId),
          method: "POST",
          body: JSON.stringify({
            id: "side-chat",
            clientId,
            method,
            params: [
              method === "closeSideChat"
                ? { sideChatId: id }
                : { mainSessionId: id },
            ],
          }),
        });
      const rejected = async (
        method: Method,
        id: string,
        status: number,
        code: string,
      ): Promise<void> => {
        for (const request of [rest, rpc]) {
          const response = await request(method, id);
          expect(response.status).toBe(status);
          expect(await response.json()).toMatchObject({
            ok: false,
            error: { code },
          });
        }
      };

      await rejected("listSideChats", "unknown", 404, "SESSION_NOT_FOUND");
      await rejected("openSideChat", root, 409, "SIDE_CHAT_UNSUPPORTED");
      const initial = await f.backend.submitPromptAndWait("main context", {
        sessionId: root,
      });
      expect(initial.prompt.status).toBe("succeeded");
      const opened = await rest("openSideChat", root);
      expect(opened.status).toBe(200);
      const entry = (await opened.json()) as {
        sideChatId: string;
        boundaryMessageId: string;
        title: string;
      };
      expect(entry).toEqual({
        sideChatId: expect.any(String),
        title: "Side chat 1",
        boundaryMessageId: expect.any(String),
      });
      const list = await rest("listSideChats", root);
      expect(list.status).toBe(200);
      const listed = await list.json();
      expect(listed).toMatchObject({
        sideChats: [
          {
            ...entry,
            workingDirectory: expect.any(String),
            createdAt: expect.any(String),
          },
        ],
      });
      expect(await (await rpc("listSideChats", root)).json()).toMatchObject({
        ok: true,
        result: listed,
      });
      await rejected(
        "openSideChat",
        entry.sideChatId,
        409,
        "SIDE_CHAT_UNSUPPORTED",
      );

      // An open side chat owned by another live process cannot be drained here.
      const db = getDatabase();
      const saved = db
        .prepare<{ data: string }>("SELECT data FROM session WHERE id=?")
        .get(entry.sideChatId);
      if (!saved) throw new Error("Expected an open side chat");
      db.prepare(
        "UPDATE session SET data=json_set(data,'$.sideChat.ownerPid',?,'$.sideChat.ownerId','another-owner') WHERE id=?",
      ).run(process.ppid, entry.sideChatId);
      await rejected("closeSideChat", entry.sideChatId, 409, "SESSION_RUNNING");
      db.prepare("UPDATE session SET data=? WHERE id=?").run(
        saved.data,
        entry.sideChatId,
      );
      for (let call = 0; call < 2; call++) {
        expect((await rest("closeSideChat", entry.sideChatId)).status).toBe(
          204,
        );
        expect(
          await (await rpc("closeSideChat", entry.sideChatId)).json(),
        ).toMatchObject({ ok: true });
      }
      expect(await (await rest("listSideChats", root)).json()).toEqual({
        sideChats: [],
      });

      const child = await f.backend.createSession();
      db.prepare("UPDATE session SET parent_id=? WHERE id=?").run(
        root,
        child.id,
      );
      await rejected("openSideChat", child.id, 409, "SESSION_NOT_ROOT");
      const archived = await f.backend.createSession();
      await f.backend.archiveSession({ sessionId: archived.id });
      await rejected("openSideChat", archived.id, 409, "SESSION_ARCHIVED");
      await commitSessionWorkspaceMove(
        planSessionWorkspaceMove(root, f.workdir + "-moved"),
      );
      await rejected("openSideChat", root, 409, "SESSION_MOVED");
    } finally {
      await f.dispose();
    }
  });

  it("remote /new reports current versus created and honors force-new", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      const first = await f.runtime.client?.getSelectedSessionId();
      const subjects: string[] = [];
      const reader = await stream(f, "web-regression");
      const pump = (async (): Promise<void> => {
        let buffer = "";
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          buffer += new TextDecoder().decode(next.value);
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!data) continue;
            const wire = JSON.parse(data.slice(6));
            if (
              wire.type === "ui.event" &&
              wire.event.type === "command.result.delivered" &&
              wire.event.output?.kind === "data"
            )
              subjects.push(wire.event.output.subject);
          }
        }
      })();
      for (const [id, argv] of [
        ["reuse", []],
        ["force", ["--no-reuse-empty-session"]],
      ] as const) {
        const response = await f.server.app.request("/api/rpc", {
          method: "POST",
          headers: headers("web-regression"),
          body: JSON.stringify({
            id,
            clientId: "web-regression",
            method: "executeCommand",
            params: [
              {
                argv,
                clientInvocationId: id,
                commandId: "new",
                path: ["new"],
                raw: "/new",
                rawArgs: argv.join(" "),
                surface: "tui",
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
        if (id === "reuse") expect(f.count()).toBe(1);
      }
      await vi.waitFor(() =>
        expect(subjects).toEqual(["session.current", "session.created"]),
      );
      expect(f.count()).toBe(2);
      await vi.waitFor(async () =>
        expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(first),
      );
      await reader.cancel();
      await pump;
    } finally {
      await f.dispose();
    }
  });

  it("only releases empty occupancy after the last SSE closes and preserves a reconnecting binding", async () => {
    const f = await fixture();
    try {
      const empty = await f.backend.createSession();
      await register(f, "owner", empty.id);
      const first = await stream(f, "owner");
      const second = await stream(f, "owner");
      await first.cancel();
      await f.runtime.createSession();
      expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(empty.id);
      await second.cancel();
      await register(f, "new-viewer");
      const before = f.count();
      expect(await create(f, "new-viewer")).toMatchObject({
        session: { id: empty.id },
        created: false,
      });
      expect(f.count()).toBe(before);
      const reconnected = await stream(f, "owner");
      const selection = await f.server.app.request("/api/rpc", {
        method: "POST",
        headers: headers("owner"),
        body: JSON.stringify({
          id: "selection",
          clientId: "owner",
          method: "getSelectedSessionId",
          params: [],
        }),
      });
      expect(await selection.json()).toMatchObject({ result: empty.id });
      await reconnected.cancel();
    } finally {
      await f.dispose();
    }
  });
  it("keeps a no-SSE client's empty root protected while its New request crosses retention", async () => {
    const f = await fixture();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const empty = await f.backend.createSession();
      await register(f, "owner", empty.id);
      const original = f.backend.createSession.bind(f.backend);
      vi.spyOn(f.backend, "createSession").mockImplementationOnce(
        async (input) => {
          entered();
          await gate;
          return original(input);
        },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = f.server.app.request("/v1/sessions", {
        method: "POST",
        headers: headers("owner"),
        body: JSON.stringify({ reuseEmpty: true }),
      });
      await entry;
      await vi.advanceTimersByTimeAsync(5001);
      await register(f, "other");
      const other = await withClock(create(f, "other"));
      expect(other.session.id).not.toBe(empty.id);
      resume();
      const owner = await withClock(pending);
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({
        session: { id: empty.id },
        created: false,
      });
    } finally {
      resume();
      vi.useRealTimers();
      await f.dispose();
    }
  });
  it("keeps a no-SSE selection pinned across retention until the root is bound", async () => {
    const f = await fixture();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const empty = await f.backend.createSession();
      await register(f, "owner");
      const original = f.backend.getSessionIndex.bind(f.backend);
      vi.spyOn(f.backend, "getSessionIndex").mockImplementationOnce(
        async () => {
          entered();
          await gate;
          return original();
        },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = f.server.app.request(`/v1/sessions/${empty.id}/select`, {
        method: "PATCH",
        headers: headers("owner"),
      });
      await entry;
      await vi.advanceTimersByTimeAsync(5001);
      await register(f, "other");
      const other = await withClock(create(f, "other"));
      expect(other.session.id).not.toBe(empty.id);
      resume();
      const selection = await withClock(pending);
      expect(selection.status).toBe(200);
      expect(await selection.json()).toMatchObject({ rootSessionId: empty.id });
    } finally {
      resume();
      vi.useRealTimers();
      await f.dispose();
    }
  });
  it("retains a reconnected client's binding after its old cleanup deadline", async () => {
    const f = await fixture();
    let first: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reconnected: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const empty = await f.backend.createSession();
      await register(f, "owner", empty.id);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      first = await stream(f, "owner");
      await first.cancel();
      await vi.advanceTimersByTimeAsync(4000);
      reconnected = await stream(f, "owner");
      await vi.advanceTimersByTimeAsync(1001);
      const selection = await f.server.app.request("/api/rpc", {
        method: "POST",
        headers: headers("owner"),
        body: JSON.stringify({
          id: "selection-after-old-deadline",
          clientId: "owner",
          method: "getSelectedSessionId",
          params: [],
        }),
      });
      expect(selection.status).toBe(200);
      expect(await selection.json()).toMatchObject({ result: empty.id });
      await register(f, "other");
      const other = await withClock(create(f, "other"));
      expect(other.session.id).not.toBe(empty.id);
    } finally {
      await reconnected?.cancel();
      vi.useRealTimers();
      await f.dispose();
    }
  });
  it("expires a registration that never opened SSE, while requests refresh a JSONRPC-only client's budget", async () => {
    const f = await fixture();
    try {
      const empty = await f.backend.createSession();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await register(f, "rpc-only", empty.id);
      await vi.advanceTimersByTimeAsync(4000);
      const read = await f.server.app.request("/api/rpc", {
        method: "POST",
        headers: headers("rpc-only"),
        body: JSON.stringify({
          id: "alive",
          clientId: "rpc-only",
          method: "getSessionIndex",
          params: [],
        }),
      });
      expect(read.status).toBe(200);
      await vi.advanceTimersByTimeAsync(2000);
      await withClock(f.runtime.createSession());
      expect(await f.runtime.client?.getSelectedSessionId()).not.toBe(empty.id);
      await vi.advanceTimersByTimeAsync(3001);
      await register(f, "after-expiry");
      const count = f.count();
      expect(await withClock(create(f, "after-expiry"))).toMatchObject({
        session: { id: empty.id },
        created: false,
      });
      expect(f.count()).toBe(count);
    } finally {
      vi.useRealTimers();
      await f.dispose();
    }
  });
  it.each(["REST", "RPC"] as const)(
    "allows %s activity after routing expiry without stealing another live client's empty root",
    async (transport) => {
      const f = await fixture();
      let otherStream: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const previous = await f.backend.createSession();
        await f.backend.submitPromptAndWait("hello", {
          sessionId: previous.id,
        });
        const empty = await f.backend.createSession();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await register(f, "returning", previous.id);
        await vi.advanceTimersByTimeAsync(5001);
        await register(f, "other");
        expect(await withClock(create(f, "other"))).toMatchObject({
          session: { id: empty.id },
          created: false,
        });
        otherStream = await stream(f, "other");
        const resumed = await f.server.app.request(
          transport === "REST" ? "/v1/sessions/index" : "/api/rpc",
          {
            method: transport === "REST" ? "GET" : "POST",
            headers: headers("returning"),
            ...(transport === "RPC"
              ? {
                  body: JSON.stringify({
                    id: "after-routing-expiry",
                    clientId: "returning",
                    method: "getSessionIndex",
                    params: [],
                  }),
                }
              : {}),
          },
        );
        expect(resumed.status).toBe(200);
        const created = await withClock(create(f, "returning"));
        expect(created.created).toBe(true);
        expect(created.session.id).not.toBe(empty.id);
        expect(f.count()).toBe(3);
        // Restoring the prior view does not release another viewer's occupancy.
        expect(await withClock(create(f, "other"))).toMatchObject({
          session: { id: empty.id },
          created: false,
        });
      } finally {
        await otherStream?.cancel();
        vi.useRealTimers();
        await f.dispose();
      }
    },
  );
  it.each(["REST", "RPC"] as const)(
    "does not revive expired occupancy for an already-aborted %s request",
    async (transport) => {
      const f = await fixture();
      try {
        const empty = await f.backend.createSession();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await register(f, "stale", empty.id);
        await vi.advanceTimersByTimeAsync(5001);
        await f.server.app.request(
          transport === "REST" ? "/v1/sessions/index" : "/api/rpc",
          {
            method: transport === "REST" ? "GET" : "POST",
            headers: headers("stale"),
            signal: AbortSignal.abort(),
            ...(transport === "RPC"
              ? {
                  body: JSON.stringify({
                    id: "aborted-after-expiry",
                    clientId: "stale",
                    method: "getSessionIndex",
                    params: [],
                  }),
                }
              : {}),
          },
        );
        await register(f, "other");
        expect(await withClock(create(f, "other"))).toMatchObject({
          session: { id: empty.id },
          created: false,
        });
        expect(f.count()).toBe(1);
      } finally {
        vi.useRealTimers();
        await f.dispose();
      }
    },
  );
  it.each(["REST", "RPC"] as const)(
    "pins %s explicit submit before root validation, even without SSE",
    async (transport) => {
      const f = await fixture();
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      try {
        const empty = await f.backend.createSession();
        await register(f, "submitter");
        const original = f.backend.getSessionIndex.bind(f.backend);
        vi.spyOn(f.backend, "getSessionIndex").mockImplementationOnce(
          async () => {
            entered();
            await gate;
            return original();
          },
        );
        const pending = f.server.app.request(
          transport === "REST" ? "/v1/prompts" : "/api/rpc",
          {
            method: "POST",
            headers: headers("submitter"),
            body: JSON.stringify(
              transport === "REST"
                ? {
                    text: "hello",
                    sessionId: empty.id,
                    clientRequestId: "race",
                  }
                : {
                    id: "submit",
                    clientId: "submitter",
                    method: "submitPromptAccepted",
                    params: [
                      "hello",
                      { sessionId: empty.id, clientRequestId: "race" },
                    ],
                  },
            ),
          },
        );
        await entry;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await vi.advanceTimersByTimeAsync(5001);
        await register(f, "other");
        const other = await withClock(create(f, "other"));
        expect(other.session.id).not.toBe(empty.id);
        resume();
        expect((await withClock(pending)).status).toBe(
          transport === "REST" ? 202 : 200,
        );
        expect(f.count()).toBe(2);
      } finally {
        resume();
        vi.useRealTimers();
        await f.dispose();
      }
    },
  );
  it("keeps explicit low-level creation distinct from UI reuse", async () => {
    const f = await fixture();
    try {
      await register(f, "caller");
      const one = await create(f, "caller", false);
      const two = await create(f, "caller", false);
      expect(one.created).toBe(true);
      expect(two.created).toBe(true);
      expect(two.session.id).not.toBe(one.session.id);
      expect(f.count()).toBe(2);
      expect(await create(f, "caller")).toMatchObject({
        session: { id: two.session.id },
        created: false,
      });
      expect(f.count()).toBe(2);
    } finally {
      await f.dispose();
    }
  });
});
