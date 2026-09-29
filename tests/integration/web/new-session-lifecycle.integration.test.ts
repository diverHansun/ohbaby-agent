import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/ohbaby-agent/src/services/database/index.js";
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
