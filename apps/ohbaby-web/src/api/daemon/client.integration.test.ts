import { describe, expect, it, vi } from "vitest";
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
          Response.json(
            {
              clientRequestId: "request_1",
              createdAt: "2026-06-12T00:00:00.000Z",
              ok: true,
              promptId: "prompt_1",
              sessionId: "session_1",
              status: "queued",
              userMessageId: "message_1",
            },
            { status: 202 },
          ),
        );
      }
      if (url.endsWith("/v1/prompts/prompt_1/completion")) {
        return Promise.resolve(
          Response.json({
            completion: {
              prompt: {
                clientRequestId: "request_1",
                createdAt: "2026-06-12T00:00:00.000Z",
                endedAt: "2026-06-12T00:00:01.000Z",
                promptId: "prompt_1",
                scopeKey: "/repo",
                sessionId: "session_1",
                status: "succeeded",
                text: "hi",
                updatedAt: "2026-06-12T00:00:01.000Z",
                userMessageId: "message_1",
              },
            },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/interactions/interaction_1/respond")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url.endsWith("/v1/commands?surface=web")) {
        const commands =
          commandCatalogVersion === "commands-v1"
            ? [
                {
                  action: "executeCommand",
                  argumentMode: "argv",
                  category: "system",
                  description: "Show backend status",
                  executionKind: "passthrough",
                  id: "status",
                  path: ["status"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
              ]
            : [
                {
                  action: "executeCommand",
                  argumentMode: "argv",
                  category: "system",
                  description: "Show backend status",
                  executionKind: "passthrough",
                  id: "status",
                  path: ["status"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
                {
                  action: "executeCommand",
                  argumentMode: "argv",
                  category: "system",
                  description: "List skills",
                  executionKind: "passthrough",
                  id: "skills",
                  path: ["skills"],
                  source: "builtin",
                  surfaces: ["tui"],
                },
                {
                  acceptsArguments: true,
                  action: "executeCommand",
                  argumentMode: "raw",
                  category: "skill",
                  description: "Use Hansun knowledge base",
                  executionKind: "skill",
                  id: "skill.hansun-db",
                  path: ["hansun-db"],
                  source: "skill",
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
      if (url.endsWith("/v1/model") && (init.method ?? "GET") === "GET") {
        return Promise.resolve(
          Response.json({
            model: {
              baseUrl: "https://open.bigmodel.cn/api/paas/v4",
              interfaceProvider: "openai-compatible",
              model: "glm-4.7",
              provider: "zhipu",
            },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/model/context-window-probe")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            probe: {
              contextWindowSource: "default",
              contextWindowTokens: 128_000,
            },
          }),
        );
      }
      if (url.endsWith("/v1/model") && init.method === "POST") {
        return Promise.resolve(
          Response.json({
            model: {
              apiKeyEnv: "ZHIPU_API_KEY",
              baseUrl: "https://open.bigmodel.cn/api/paas/v4",
              contextWindowSource: "default",
              contextWindowTokens: 128_000,
              envPath: ".env",
              interfaceProvider: "openai-compatible",
              model: "glm-4.7",
              modelJsonPath: "model.json",
              provider: "zhipu",
              saved: true,
            },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/settings/search-api-key")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            search: {
              apiKeyEnv: "TAVILY_API_KEY",
              envPath: ".env",
              provider: "tavily",
              searchJsonPath: "search.json",
            },
          }),
        );
      }
      if (url.endsWith("/v1/sessions/session_1/context-window")) {
        return Promise.resolve(
          Response.json({
            ok: true,
            usage: {
              contextWindowRatio: 0.01,
              contextWindowTokens: 128_000,
              currentTokens: 1_000,
              estimatedAt: "2026-06-12T00:00:00.000Z",
              modelId: "glm-4.7",
              sessionId: "session_1",
            },
          }),
        );
      }
      if (url.endsWith("/v1/sessions/session_1/compact")) {
        return Promise.resolve(
          Response.json({
            compact: {
              sessionId: "session_1",
              status: "not-needed",
              usageAfter: {
                contextLimit: 128_000,
                currentTokens: 1_000,
                modelId: "glm-4.7",
                remainingTokens: 127_000,
                usageRatio: 0.01,
              },
              usageBefore: {
                contextLimit: 128_000,
                currentTokens: 1_000,
                modelId: "glm-4.7",
                remainingTokens: 127_000,
                usageRatio: 0.01,
              },
            },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/sessions/session_1/archive")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const config: OhbabyBootstrapConfig = {
      baseUrl: "http://127.0.0.1:4096",
      clientId: "client_web",
      directory: "/repo",
      startupIntent: { startupSessionMode: { type: "fresh" } },
      token: "token_1",
    };
    const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
    await runtime.ready;
    const client = runtime.client;
    if (!client) throw new Error("Expected an active browser client");

    expect(runtime.store.getSnapshot()).toMatchObject({
      connectionState: "live",
      currentModel: { model: "glm-4.7", provider: "zhipu" },
      view: {
        lastAppliedSeqNum: 2,
        snapshot: {
          sessions: [{ id: "session_1" }],
        },
      },
    });

    const receipt = await client.submitPromptAccepted("hi", {
      clientRequestId: "request_1",
      sessionId: "session_1",
    });
    expect(receipt).toEqual({
      clientRequestId: "request_1",
      createdAt: "2026-06-12T00:00:00.000Z",
      promptId: "prompt_1",
      sessionId: "session_1",
      status: "queued",
      userMessageId: "message_1",
    });
    expect(requests.at(-1)).toMatchObject({
      body: JSON.stringify({
        clientRequestId: "request_1",
        sessionId: "session_1",
        text: "hi",
      }),
      method: "POST",
      url: "http://127.0.0.1:4096/v1/prompts",
    });
    expect(requests.at(-1)?.headers.get("authorization")).toBe(
      "Bearer token_1",
    );
    await expect(client.waitForPrompt(receipt.promptId)).resolves.toMatchObject(
      { prompt: { status: "succeeded" } },
    );
    await client.respondInteraction("interaction_1", {
      choiceId: "choice_1",
      kind: "accepted",
    });
    expect(requests.at(-1)).toMatchObject({
      body: JSON.stringify({
        response: { choiceId: "choice_1", kind: "accepted" },
      }),
      method: "POST",
      url: "http://127.0.0.1:4096/v1/interactions/interaction_1/respond",
    });
    await expect(client.getSnapshot()).resolves.toMatchObject({
      activeSessionId: "session_1",
    });

    await client.setPermission({
      level: "full-access",
      mode: "plan",
    });
    expect(requests.at(-1)).toMatchObject({
      body: JSON.stringify({ level: "full-access", mode: "plan" }),
      method: "PATCH",
      url: "http://127.0.0.1:4096/v1/permission",
    });

    const catalog = await runtime.listWebCommands();
    expect(catalog.commands.map((command) => command.id)).toEqual(["status"]);

    await runtime.executeSlashCommand({
      sessionId: "session_1",
      text: "/status",
    });
    expect(requests.at(-2)).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:4096/v1/commands?surface=web",
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
      runtime.executeSlashCommand({
        sessionId: "session_1",
        text: "/sessions",
      }),
    ).rejects.toThrow('Unknown command "/sessions"');
    expect(requests).toHaveLength(beforeUnsupported);
    commandCatalogVersion = "commands-v2";
    expect(sseController).toBeDefined();
    const delivered: string[] = [];
    const observationDiagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    runtime.store.setError("transport error must survive");
    client.subscribeEvents(() => {
      throw new Error("observer failed");
    });
    client.subscribeEvents((event) => {
      expect(runtime.store.getSnapshot().view.lastAppliedSeqNum).toBe(3);
      delivered.push(event.type);
    });
    expect(
      requests.filter((request) => request.url.endsWith("/v1/events")),
    ).toHaveLength(1);
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
    try {
      await waitFor(
        () => runtime.store.getSnapshot().view.lastAppliedSeqNum === 3,
        "timed out waiting for catalog update event",
      );
      expect(delivered).toEqual(["command.catalog.updated"]);
      expect(runtime.store.getSnapshot().error).toBe(
        "transport error must survive",
      );
      expect(observationDiagnostic).toHaveBeenCalledWith(
        '{"stage":"event-subscriber","type":"ui.observation.failure"}',
      );
    } finally {
      observationDiagnostic.mockRestore();
    }
    await client.listCommands({ surface: "web" });
    const catalogRequestsAfterCommittedRefresh = requests.filter((request) =>
      request.url.endsWith("/v1/commands?surface=web"),
    ).length;
    sseController?.enqueue(
      sseFrame(
        {
          event: {
            reason: "duplicate",
            timestamp: Date.parse("2026-06-12T00:00:02.000Z"),
            type: "command.catalog.updated",
            version: "commands-v2",
          },
          type: "ui.event",
        },
        3,
      ),
    );
    await delay(20);
    expect(delivered).toEqual(["command.catalog.updated"]);
    await client.listCommands({ surface: "web" });
    expect(
      requests.filter((request) =>
        request.url.endsWith("/v1/commands?surface=web"),
      ),
    ).toHaveLength(catalogRequestsAfterCommittedRefresh);
    await runtime.executeSlashCommand({
      sessionId: "session_1",
      text: "/skills",
    });
    expect(
      requests.filter((request) =>
        request.url.endsWith("/v1/commands?surface=web"),
      ),
    ).toHaveLength(catalogRequestsAfterCommittedRefresh);
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
    await runtime.executeSlashCommand({
      sessionId: "session_1",
      text: "/hansun-db 查 X",
    });
    const skillBody = JSON.parse(requests.at(-1)?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(skillBody).toMatchObject({
      argumentMode: "raw",
      argv: ["查", "X"],
      commandId: "skill.hansun-db",
      path: ["hansun-db"],
      raw: "/hansun-db 查 X",
      rawArgs: "查 X",
      sessionId: "session_1",
      surface: "tui",
    });

    await expect(client.getCurrentModel()).resolves.toMatchObject({
      model: "glm-4.7",
      provider: "zhipu",
    });
    await expect(
      client.probeModelContextWindow({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      }),
    ).resolves.toMatchObject({ contextWindowTokens: 128_000 });
    await expect(
      client.connectModel({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      }),
    ).resolves.toMatchObject({ model: "glm-4.7" });
    expect(runtime.store.getSnapshot().currentModel).toMatchObject({
      model: "glm-4.7",
      provider: "zhipu",
    });
    await expect(
      client.setSearchApiKey({
        apiKeyEnv: "TAVILY_API_KEY",
        provider: "tavily",
      }),
    ).resolves.toMatchObject({ provider: "tavily" });
    await expect(
      client.getContextWindowUsage({ sessionId: "session_1" }),
    ).resolves.toMatchObject({ sessionId: "session_1" });
    await expect(
      client.compactSession({ force: true, sessionId: "session_1" }),
    ).resolves.toMatchObject({ sessionId: "session_1" });
    await expect(
      client.archiveSession({ sessionId: "session_1" }),
    ).resolves.toBeUndefined();
    expect(requests.slice(-3).map((request) => request.url)).toEqual([
      "http://127.0.0.1:4096/v1/sessions/session_1/archive",
      "http://127.0.0.1:4096/v1/snapshot",
      "http://127.0.0.1:4096/v1/model",
    ]);
    expect(requests.at(-3)?.method).toBe("PATCH");
    expect(requests.slice(-9).map((request) => request.url)).toEqual([
      "http://127.0.0.1:4096/v1/model",
      "http://127.0.0.1:4096/v1/model/context-window-probe",
      "http://127.0.0.1:4096/v1/model",
      "http://127.0.0.1:4096/v1/settings/search-api-key",
      "http://127.0.0.1:4096/v1/sessions/session_1/context-window",
      "http://127.0.0.1:4096/v1/sessions/session_1/compact",
      "http://127.0.0.1:4096/v1/sessions/session_1/archive",
      "http://127.0.0.1:4096/v1/snapshot",
      "http://127.0.0.1:4096/v1/model",
    ]);
    sseController?.close();
    await runtime.dispose();
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
      if (url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
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
        directory: "/repo",
        token: "token_1",
      });
      await runtime.ready;
      await runtime.dispose();

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

  it("does not advance Last-Event-ID beyond the committed resync snapshot", async () => {
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
      if (url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
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
    expect(eventRequestHeaders[1]?.get("last-event-id")).toBe("0");
    firstSseController?.close();
    secondSseController?.close();
    await runtime.dispose();
  });

  it("replays buffered SSE events when an imperative snapshot resync fails", async () => {
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let catalogRequests = 0;
    let failModelRefresh = false;
    let snapshotRequests = 0;
    let resolveFailedSnapshot: ((response: Response) => void) | undefined;
    const failedSnapshot = new Promise<Response>((resolve) => {
      resolveFailedSnapshot = resolve;
    });
    const fetchImpl: typeof fetch = (input) => {
      const url = urlFromRequestInput(input);
      if (url.endsWith("/v1/scopes")) {
        return Promise.resolve(Response.json({}, { status: 404 }));
      }
      if (url.endsWith("/v1/clients")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url.endsWith("/v1/events")) {
        return Promise.resolve(
          new Response(
            createSseStream((controller) => {
              sseController = controller;
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        snapshotRequests += 1;
        if (snapshotRequests === 2) return failedSnapshot;
        return Promise.resolve(
          Response.json({
            ok: true,
            seqNum: 0,
            snapshot: {
              activeSessionId: "session_1",
              permission: {
                level: "default",
                mode: "auto",
                sessionRules: [],
              },
              permissions: [],
              runs: [],
              sessions: [
                {
                  createdAt: "2026-06-12T00:00:00.000Z",
                  id: "session_1",
                  messages: [],
                  title: "before",
                  updatedAt: "2026-06-12T00:00:00.000Z",
                },
              ],
              status: { kind: "idle" },
            },
          }),
        );
      }
      if (url.endsWith("/v1/model")) {
        if (failModelRefresh) {
          failModelRefresh = false;
          return Promise.resolve(
            Response.json(
              { error: { message: "model failed" } },
              { status: 500 },
            ),
          );
        }
        return Promise.resolve(Response.json({ model: null, ok: true }));
      }
      if (url.endsWith("/v1/commands?surface=web")) {
        catalogRequests += 1;
        return Promise.resolve(
          Response.json({
            catalog: { commands: [], version: `v${String(catalogRequests)}` },
            ok: true,
          }),
        );
      }
      if (url.endsWith("/v1/sessions/session_1/select")) {
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    };
    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        token: "token_1",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;
    const client = runtime.client;
    if (!client) throw new Error("Expected active client");
    await expect(
      client.listCommands({ surface: "web" }),
    ).resolves.toMatchObject({ version: "v1" });

    const selecting = runtime.selectSession("session_1");
    await waitFor(() => snapshotRequests === 2, "snapshot did not start");
    sseController?.enqueue(
      sseFrame(
        {
          event: {
            reason: "buffered",
            timestamp: Date.parse("2026-06-12T00:00:01.000Z"),
            type: "command.catalog.updated",
            version: "v2",
          },
          type: "ui.event",
        },
        1,
      ),
    );
    sseController?.enqueue(
      sseFrame(
        {
          event: {
            session: {
              createdAt: "2026-06-12T00:00:00.000Z",
              id: "session_1",
              messages: [],
              title: "buffered",
              updatedAt: "2026-06-12T00:00:01.000Z",
            },
            type: "session.updated",
          },
          type: "ui.event",
        },
        2,
      ),
    );
    resolveFailedSnapshot?.(
      Response.json({ error: { message: "snapshot failed" } }, { status: 500 }),
    );
    await expect(selecting).rejects.toThrow("snapshot failed");
    sseController?.enqueue(
      sseFrame(
        {
          event: { status: { kind: "idle" }, type: "runtime.updated" },
          type: "ui.event",
        },
        3,
      ),
    );
    await waitFor(
      () => runtime.store.getSnapshot().view.lastAppliedSeqNum === 3,
      "events did not resume",
    );
    await expect(
      client.listCommands({ surface: "web" }),
    ).resolves.toMatchObject({ version: "v2" });

    expect(runtime.store.getSnapshot()).toMatchObject({
      connectionState: "live",
      view: {
        commandCatalogVersion: "v2",
        lastAppliedSeqNum: 3,
        snapshot: { sessions: [{ id: "session_1", title: "buffered" }] },
      },
    });
    expect(catalogRequests).toBe(2);
    failModelRefresh = true;
    await expect(runtime.selectSession("session_1")).rejects.toThrow(
      "model failed",
    );
    expect(runtime.store.getSnapshot().connectionState).toBe("live");
    sseController?.close();
    await runtime.dispose();
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
      if (url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };

    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        token: "token_1",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;

    expect(runtime.store.getSnapshot()).toMatchObject({
      connectionState: "live",
      error: null,
    });
    await runtime.dispose();
  });

  it("keeps transport controls and invalid sequences out of UiEvent subscribers", async () => {
    let sseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let snapshotRequests = 0;
    const snapshot = {
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
    } as const;
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
              sseController = controller;
              controller.enqueue(
                sseFrame({ clientId: "client_web", type: "hello" }),
              );
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }
      if (url.endsWith("/v1/snapshot")) {
        snapshotRequests += 1;
        return Promise.resolve(
          Response.json({ ok: true, seqNum: 0, snapshot }),
        );
      }
      if (url.endsWith("/v1/model")) {
        return Promise.resolve(Response.json({ model: null, ok: true }));
      }
      return Promise.resolve(
        Response.json({ error: { message: "not found" } }, { status: 404 }),
      );
    };
    const runtime = createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: "token_1",
      },
      { fetch: fetchImpl },
    );
    await runtime.ready;
    const client = runtime.client;
    if (!client) throw new Error("Expected an active browser client");
    const delivered: string[] = [];
    client.subscribeEvents((event) => {
      delivered.push(event.type);
    });

    sseController?.enqueue(sseFrame({ clientId: "client_web", type: "hello" }));
    sseController?.enqueue(
      sseFrame({ message: "transport warning", type: "error" }),
    );
    sseController?.enqueue(
      sseFrame({
        event: { status: { kind: "idle" }, type: "runtime.updated" },
        type: "ui.event",
      }),
    );
    sseController?.enqueue(
      sseFrame(
        {
          event: { status: { kind: "idle" }, type: "runtime.updated" },
          type: "ui.event",
        },
        -1,
      ),
    );
    await waitFor(
      () =>
        runtime.store.getSnapshot().error ===
        "Daemon event is missing a valid sequence id",
      "timed out waiting for invalid sequence diagnostic",
    );

    expect(delivered).toEqual([]);
    expect(runtime.store.getSnapshot().view.lastAppliedSeqNum).toBe(0);

    sseController?.enqueue(
      sseFrame({ maxSeqNum: 0, minSeqNum: 0, type: "resync-required" }),
    );
    await waitFor(
      () => snapshotRequests === 2 && delivered.length === 1,
      "timed out waiting for the local resync barrier",
    );
    expect(delivered).toEqual(["snapshot.replaced"]);
    expect(runtime.store.getSnapshot().view.lastAppliedSeqNum).toBe(0);

    sseController?.close();
    await runtime.dispose();
  });
});
