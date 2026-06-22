import { describe, expect, it } from "vitest";
import { createOhbabyWebRuntime } from "./client.js";
import type { OhbabyBootstrapConfig, WebSseEvent } from "./wire.js";

const encoder = new TextEncoder();

function sseFrame(event: WebSseEvent, id?: number): Uint8Array {
  return encoder.encode(
    `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event.type}\ndata: ${JSON.stringify(
      event,
    )}\n\n`,
  );
}

function createSseStream(
  start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start });
}

function urlFromRequestInput(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(message);
}

describe("ohbaby-web daemon client", () => {
  it("connects, buffers events before snapshot, and submits prompts", async () => {
    const requests: {
      readonly body?: string;
      readonly headers: Headers;
      readonly method: string;
      readonly url: string;
    }[] = [];
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let commandCatalogVersion: "commands-v1" | "commands-v2" = "commands-v1";

    const fetchImpl: typeof fetch = (input, init = {}) => {
      const url = urlFromRequestInput(input);
      const headers = new Headers(init.headers);
      requests.push({
        body: typeof init.body === "string" ? init.body : undefined,
        headers,
        method: init.method ?? "GET",
        url,
      });

      if (url.endsWith("/v1/clients")) {
        return Promise.resolve(
          Response.json({ clientId: "client_web", ok: true }),
        );
      }
      if (url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            createSseStream((controller) => {
              sseController = controller;
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
              controller.enqueue(
                sseFrame(
                  {
                    event: {
                      session: {
                        createdAt: "2026-06-12T00:00:00.000Z",
                        id: "session_1",
                        messages: [],
                        title: "Session",
                        updatedAt: "2026-06-12T00:00:00.000Z",
                      },
                      type: "session.updated",
                    },
                    type: "ui.event",
                  },
                  2,
                ),
              );
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 1,
            snapshot: {
              activeSessionId: "session_1",
              permission: {
                level: "default",
                mode: "auto",
                sessionRules: [],
              },
              permissions: [],
              runs: [],
              sessions: [],
              status: { kind: "idle" },
            },
          }),
        );
      }
      if (url.endsWith("/v1/prompts")) {
        return Promise.resolve(
          Response.json({ ok: true, sessionId: "session_1" }, { status: 202 }),
        );
      }
      if (url.endsWith("/v1/commands?surface=tui")) {
        const commands =
          commandCatalogVersion === "commands-v1"
            ? [
                {
                  argumentMode: "argv",
                  category: "system",
                  description: "Show backend status",
                  id: "status",
                  path: ["status"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
                {
                  argumentMode: "argv",
                  category: "session",
                  description: "Browse sessions",
                  id: "sessions",
                  parentBehavior: "interaction",
                  path: ["sessions"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
              ]
            : [
                {
                  argumentMode: "argv",
                  category: "system",
                  description: "Show backend status",
                  id: "status",
                  path: ["status"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
                {
                  argumentMode: "argv",
                  category: "system",
                  description: "List skills",
                  id: "skills",
                  path: ["skills"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
              ];
        return Promise.resolve(
          Response.json({
            catalog: {
              commands,
              version: commandCatalogVersion,
            },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/commands")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url.endsWith("/v1/permission")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            permission: {
              level: "full-access",
              mode: "plan",
              sessionRules: [],
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const config: OhbabyBootstrapConfig = {
      baseUrl: "http://127.0.0.1:4096",
      clientId: "client_web",
      startupIntent: { startupSessionMode: { type: "fresh" } },
      token: "token_1",
    };
    const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
    await runtime.ready;

    expect(runtime.store.getSnapshot()).toMatchObject({
      connectionState: "live",
      view: {
        lastAppliedSeqNum: 2,
        snapshot: {
          sessions: [{ id: "session_1" }],
        },
      },
    });

    await runtime.client.submitPrompt({ sessionId: "session_1", text: "hi" });
    expect(requests.at(-1)).toMatchObject({
      body: JSON.stringify({ sessionId: "session_1", text: "hi" }),
      method: "POST",
      url: "http://127.0.0.1:4096/v1/prompts",
    });
    expect(requests.at(-1)?.headers.get("authorization")).toBe(
      "Bearer token_1",
    );

    await runtime.client.setPermission({
      level: "full-access",
      mode: "plan",
    });
    expect(requests.at(-1)).toMatchObject({
      body: JSON.stringify({ level: "full-access", mode: "plan" }),
      method: "PATCH",
      url: "http://127.0.0.1:4096/v1/permission",
    });

    const catalog = await (
      runtime.client as typeof runtime.client & {
        readonly listCommands: () => Promise<{
          readonly commands: readonly { readonly id: string }[];
          readonly version: string;
        }>;
      }
    ).listCommands();
    expect(catalog.commands.map((command) => command.id)).toEqual(["status"]);

    await runtime.client.executeSlashCommand({
      sessionId: "session_1",
      text: "/status",
    });
    expect(requests.at(-2)).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:4096/v1/commands?surface=tui",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:4096/v1/commands",
    });
    const commandBody = JSON.parse(requests.at(-1)?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(commandBody).toMatchObject({
      argv: [],
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    });
    expect(commandBody.clientInvocationId).toEqual(expect.any(String));
    const beforeUnsupported = requests.length;
    await expect(
      runtime.client.executeSlashCommand({
        sessionId: "session_1",
        text: "/sessions",
      }),
    ).rejects.toThrow('Unknown command "/sessions"');
    expect(requests).toHaveLength(beforeUnsupported);
    commandCatalogVersion = "commands-v2";
    expect(sseController).toBeDefined();
    sseController?.enqueue(
      sseFrame(
        {
          event: {
            reason: "test",
            timestamp: Date.parse("2026-06-12T00:00:01.000Z"),
            type: "command.catalog.updated",
            version: "commands-v2",
          },
          type: "ui.event",
        },
        3,
      ),
    );
    await waitFor(
      () => runtime.store.getSnapshot().view.lastAppliedSeqNum === 3,
      "timed out waiting for catalog update event",
    );
    const catalogRequestsBeforeRefresh = requests.filter((request) =>
      request.url.endsWith("/v1/commands?surface=tui"),
    ).length;
    await runtime.client.executeSlashCommand({
      sessionId: "session_1",
      text: "/skills",
    });
    expect(
      requests.filter((request) =>
        request.url.endsWith("/v1/commands?surface=tui"),
      ),
    ).toHaveLength(catalogRequestsBeforeRefresh + 1);
    const skillsBody = JSON.parse(requests.at(-1)?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(skillsBody).toMatchObject({
      commandId: "skills",
      path: ["skills"],
      raw: "/skills",
      sessionId: "session_1",
    });
    sseController?.close();
    await runtime.client.close();
  });

  it("binds the native browser fetch implementation when no custom fetch is provided", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const nativeLikeFetch = function (
      this: typeof globalThis,
      input: RequestInfo | URL,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      const url = urlFromRequestInput(input);
      calls.push(url);
      if (url.endsWith("/v1/clients")) {
        return Promise.resolve(
          Response.json({ clientId: "client_web", ok: true }),
        );
      }
      if (url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            createSseStream((controller) => {
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
              controller.close();
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: {
              activeSessionId: null,
              permission: {
                level: "default",
                mode: "auto",
                sessionRules: [],
              },
              permissions: [],
              runs: [],
              sessions: [],
              status: { kind: "idle" },
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    try {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: nativeLikeFetch,
      });

      const runtime = createOhbabyWebRuntime({
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        token: "token_1",
      });
      await runtime.ready;
      await runtime.client.close();

      expect(calls).toContain("http://127.0.0.1:4096/v1/clients");
      expect(calls).toContain("http://127.0.0.1:4096/v1/events");
      expect(calls).toContain("http://127.0.0.1:4096/v1/snapshot");
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
      });
    }
  });

  it("does not advance Last-Event-ID before resync snapshot succeeds", async () => {
    const eventRequestHeaders: Headers[] = [];
    let firstSseController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let secondSseController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let snapshotRequests = 0;

    const fetchImpl: typeof fetch = (input, init = {}) => {
      const url = urlFromRequestInput(input);
      if (url.endsWith("/v1/clients")) {
        return Promise.resolve(
          Response.json({ clientId: "client_web", ok: true }),
        );
      }
      if (url.endsWith("/v1/events")) {
        eventRequestHeaders.push(new Headers(init.headers));
        const index = eventRequestHeaders.length;
        return Promise.resolve(
          new Response(
            createSseStream((controller) => {
              if (index === 1) {
                firstSseController = controller;
              } else {
                secondSseController = controller;
              }
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        snapshotRequests += 1;
        if (snapshotRequests > 1) {
          return Promise.resolve(
            Response.json(
              { error: { message: "snapshot failed" } },
              { status: 500 },
            ),
          );
        }
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: {
              activeSessionId: null,
              permission: {
                level: "default",
                mode: "auto",
                sessionRules: [],
              },
              permissions: [],
              runs: [],
              sessions: [],
              status: { kind: "idle" },
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        token: "token_1",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;
    firstSseController?.enqueue(
      sseFrame({ maxSeqNum: 5, minSeqNum: 1, type: "resync-required" }),
    );

    await waitFor(
      () => eventRequestHeaders.length >= 2,
      "timed out waiting for SSE reconnect",
    );
    expect(eventRequestHeaders[1]?.get("last-event-id")).toBeNull();
    firstSseController?.close();
    secondSseController?.close();
    await runtime.client.close();
  });

  it("clears transient stream errors after the SSE connection returns live", async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = urlFromRequestInput(input);
      if (url.endsWith("/v1/clients")) {
        return Promise.resolve(
          Response.json({ clientId: "client_web", ok: true }),
        );
      }
      if (url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            createSseStream((controller) => {
              controller.enqueue(
                sseFrame({ message: "temporary warning", type: "error" }),
              );
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
              controller.close();
            }),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: {
              activeSessionId: null,
              permission: {
                level: "default",
                mode: "auto",
                sessionRules: [],
              },
              permissions: [],
              runs: [],
              sessions: [],
              status: { kind: "idle" },
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        token: "token_1",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;

    expect(runtime.store.getSnapshot()).toMatchObject({
      connectionState: "live",
      error: null,
    });
    await runtime.client.close();
  });
});
