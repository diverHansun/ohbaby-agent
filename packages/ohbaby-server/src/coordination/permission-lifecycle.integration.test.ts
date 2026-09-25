import { describe, expect, it, vi } from "vitest";
import type {
  UiBackendClient,
  UiPermissionSnapshot,
  UiSessionIndexEntry,
  UiPermissionBinding,
  UiSnapshot,
} from "ohbaby-sdk";
import type { UiPromptQueueExecutionPort } from "ohbaby-agent";
import { createDaemonServerApp } from "../app/create-app.js";

const headers = {
  authorization: "Bearer permission-token",
  "content-type": "application/json",
  "x-ohbaby-client-id": "client-a",
};
const index = [
  {
    id: "root",
    title: "Root",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
  },
  {
    id: "other",
    title: "Other",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
  },
];
function fakeBackend(): UiBackendClient & UiPromptQueueExecutionPort {
  const getSnapshot = vi.fn(() =>
    Promise.reject(new Error("history unavailable")),
  );
  return {
    getSnapshot,
    getSessionIndex: () => Promise.resolve(index),
    getPermissionSnapshot: (input: { rootSessionId: string | null }) =>
      Promise.resolve({
        permissionEpoch: "epoch-1",
        rootSessionId: input.rootSessionId,
        permissionRevision: 0,
        requests: [],
      }),
    subscribeEvents: () => () => undefined,
    subscribePermissionEvents: () => () => undefined,
  } as unknown as UiBackendClient & UiPromptQueueExecutionPort;
}

describe("independent server permission lifecycle", () => {
  it("starts and registers a client without reading failed chat history", async () => {
    const backend = fakeBackend();
    const app = createDaemonServerApp({
      backend,
      authToken: "permission-token",
    });
    try {
      await expect(app.start()).resolves.toBeUndefined();
      const response = await app.app.request("/v1/clients", {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: "client-a",
          startupIntent: { resumeSessionId: "root" },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        permissionEpoch: "epoch-1",
        rootSessionId: "root",
        bindingGeneration: 1,
      });
      expect(vi.spyOn(backend, "getSnapshot")).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });
});

it("rejects an old binding after an async snapshot read and rejects child selection", async () => {
  const backend = fakeBackend();
  const app = createDaemonServerApp({ backend, authToken: "permission-token" });
  await app.start();
  try {
    const registration = await app.app.request("/v1/clients", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId: "client-a",
        startupIntent: { resumeSessionId: "root" },
      }),
    });
    const binding = (await registration.json()) as {
      permissionEpoch: string;
      bindingGeneration: number;
      rootSessionId: string;
    };
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = backend.getPermissionSnapshot.bind(backend);
    backend.getPermissionSnapshot = async (
      input,
    ): Promise<UiPermissionSnapshot> => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(input);
    };
    const pending = app.app.request(
      `/v1/permissions?rootSessionId=root&permissionEpoch=${binding.permissionEpoch}&bindingGeneration=${String(binding.bindingGeneration)}`,
      { headers },
    );
    await reading;
    const selected = await app.app.request("/v1/sessions/other/select", {
      method: "PATCH",
      headers,
    });
    expect(selected.status).toBe(200);
    release();
    expect((await pending).status).toBe(409);
    backend.getSessionIndex = (): Promise<readonly UiSessionIndexEntry[]> =>
      Promise.resolve([
        ...index,
        { ...index[0], id: "child", parentId: "root", isSubagent: true },
      ]);
    const child = await app.app.request("/v1/sessions/child/select", {
      method: "PATCH",
      headers,
    });
    expect(child.status).toBe(409);
    const rpc = await app.app.request("/api/rpc", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "selected",
        clientId: "client-a",
        method: "getSelectedSessionId",
        params: [],
      }),
    });
    expect(await rpc.json()).toMatchObject({ result: "other" });
  } finally {
    await app.dispose();
  }
});

it("rejects an old response after async root validation without consuming approval", async () => {
  const backend = fakeBackend();
  const respond = vi.fn(() => Promise.resolve());
  backend.respondPermission = respond;
  const app = createDaemonServerApp({ backend, authToken: "permission-token" });
  await app.start();
  try {
    const registration = await app.app.request("/v1/clients", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId: "client-a",
        startupIntent: { resumeSessionId: "root" },
      }),
    });
    const binding = await registration.json();
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    backend.getSessionIndex = async (): Promise<
      readonly UiSessionIndexEntry[]
    > => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return index;
    };
    const pending = app.app.request("/v1/permissions/request", {
      method: "POST",
      headers,
      body: JSON.stringify({
        response: { choiceId: "allow_once" },
        context: binding,
      }),
    });
    await reading;
    backend.getSessionIndex = (): Promise<readonly UiSessionIndexEntry[]> =>
      Promise.resolve(index);
    await app.app.request("/v1/sessions/other/select", {
      method: "PATCH",
      headers,
    });
    release();
    expect((await pending).status).toBe(409);
    expect(respond).not.toHaveBeenCalled();
  } finally {
    await app.dispose();
  }
});

it.each([false, true])(
  "recovers real HTTP/RPC/SSE approval with failed history and final-delivery failure=%s",
  async (failFinalDelivery) => {
    const { createInProcessUiBackendClient } = await import("ohbaby-agent");
    const { listenToNodeServer } = await import("../transport/node-listen.js");
    let step = 0;
    const backend = createInProcessUiBackendClient({
      initialSnapshot: {
        activeSessionId: "root",
        sessions: index.map((session) => ({ ...session, messages: [] })),
        permissions: [],
        runs: [],
        status: { kind: "idle" },
      },
      llmClient: {
        config: {
          apiKeyEnv: "TEST_KEY",
          baseUrl: "https://invalid.test",
          interfaceProvider: "openai-compatible",
          maxTokens: 100,
          model: "fake-model",
          provider: "openai",
          temperature: 0,
        },
        provider: {
          client: {},
          id: "fake",
          kind: "openai-compatible",
          isAbortError: () => false,
          streamResponse() {
            const event =
              step++ === 0
                ? {
                    finishReason: "tool_calls" as const,
                    toolCallDeltas: [
                      {
                        index: 0,
                        id: "call_real",
                        name: "bash",
                        argumentsDelta: JSON.stringify({
                          command:
                            "node -e \"process.stdout.write('approval-real')\"",
                        }),
                      },
                    ],
                  }
                : { finishReason: "stop" as const, textDelta: "done" };
            return Promise.resolve(
              (async function* (): AsyncGenerator<typeof event, void, unknown> {
                await Promise.resolve();
                yield event;
              })(),
            );
          },
        },
      },
    });
    backend.getSnapshot = (): Promise<UiSnapshot> =>
      Promise.reject(new Error("chat history unavailable"));
    const app = createDaemonServerApp({
      backend,
      authToken: "permission-token",
    });
    await app.start();
    const server = await listenToNodeServer({
      app: app.app,
      host: "127.0.0.1",
      port: 0,
    });
    const controllers: AbortController[] = [];
    const request = (url: string, init: RequestInit = {}): Promise<Response> =>
      fetch(server.url + url, {
        ...init,
        headers: {
          ...headers,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    const readFrame = (response: Response) => {
      if (!response.body) throw new Error("Missing SSE response body");
      const reader: ReadableStreamDefaultReader<Uint8Array> =
        response.body.getReader();
      let buffer = "";
      return async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const split = buffer.indexOf("\n\n");
          if (split >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (data)
              return JSON.parse(data.slice(6)) as Record<string, unknown>;
          } else {
            const next = await reader.read();
            if (next.done) throw new Error("SSE ended");
            buffer += new TextDecoder().decode(next.value);
          }
        }
      };
    };
    try {
      const register = async (
        clientId: string,
      ): Promise<UiPermissionBinding> => {
        const response = await request("/v1/clients", {
          method: "POST",
          body: JSON.stringify({
            clientId,
            startupIntent: { resumeSessionId: "root" },
          }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as {
          permissionEpoch: string;
          rootSessionId: string;
          bindingGeneration: number;
        };
      };
      const binding = await register("client-a");
      await register("client-b");
      const connect = async (
        clientId: string,
      ): Promise<() => Promise<Record<string, unknown>>> => {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await request("/v1/events", {
          headers: { "x-ohbaby-client-id": clientId },
          signal: controller.signal,
        });
        const next = readFrame(response);
        expect(await next()).toMatchObject({
          type: "hello",
          permissionEpoch: binding.permissionEpoch,
          rootSessionId: "root",
        });
        return next;
      };
      const a = await connect("client-a");
      const b = await connect("client-b");
      const requested = new Promise<import("ohbaby-sdk").UiPermissionRequest>(
        (resolve) => {
          const stop = backend.subscribePermissionEvents((event) => {
            if (event.type === "permission.requested") {
              stop();
              resolve(event.request);
            }
          });
        },
      );
      const accepted = await request("/v1/prompts", {
        method: "POST",
        body: JSON.stringify({
          text: "run once",
          sessionId: "root",
          clientRequestId: "real-permission",
        }),
      });
      expect(accepted.status).toBe(202);
      const receipt = (await accepted.json()) as { promptId: string };
      const permission = await requested;
      const nextPermission = async (
        next: () => Promise<Record<string, unknown>>,
        type: string,
      ): Promise<unknown> => {
        for (;;) {
          const frame = await next();
          if (
            frame.type === "ui.event" &&
            (frame.event as { type?: string }).type === type
          )
            return frame.event;
        }
      };
      expect(await nextPermission(a, "permission.requested")).toMatchObject({
        request: { id: permission.id },
      });
      expect(await nextPermission(b, "permission.requested")).toMatchObject({
        request: { id: permission.id },
      });
      const fresh = await register("client-refresh");
      const query = `/v1/permissions?rootSessionId=root&permissionEpoch=${fresh.permissionEpoch}&bindingGeneration=${String(fresh.bindingGeneration)}`;
      const snapshotResponse = await request(query, {
        headers: { "x-ohbaby-client-id": "client-refresh" },
      });
      expect(await snapshotResponse.json()).toMatchObject({
        snapshot: {
          requests: [
            { id: permission.id, runId: permission.runId, callId: "call_real" },
          ],
        },
      });
      // Saved method is invoked with its original controller using call below.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const enqueue = ReadableStreamDefaultController.prototype.enqueue;
      let failed = false;
      const writeFailure = failFinalDelivery
        ? vi
            .spyOn(ReadableStreamDefaultController.prototype, "enqueue")
            .mockImplementation(function (
              this: ReadableStreamDefaultController<unknown>,
              chunk: unknown,
            ) {
              if (
                !failed &&
                chunk instanceof Uint8Array &&
                new TextDecoder()
                  .decode(chunk)
                  .includes('"type":"permission.resolved"')
              ) {
                failed = true;
                throw new Error("socket write failed");
              }
              enqueue.call(this, chunk);
            })
        : undefined;
      const rpc = await request("/api/rpc", {
        method: "POST",
        body: JSON.stringify({
          id: "answer",
          clientId: "client-b",
          method: "respondPermission",
          params: [permission.id, { choiceId: "allow_once" }, binding],
        }),
      });
      expect(rpc.status).toBe(200);
      writeFailure?.mockRestore();
      if (failFinalDelivery) {
        expect(failed).toBe(true);
        await expect(nextPermission(a, "permission.resolved")).rejects.toThrow(
          "SSE ended",
        );
      } else
        expect(await nextPermission(a, "permission.resolved")).toMatchObject({
          requestId: permission.id,
        });
      expect(await nextPermission(b, "permission.resolved")).toMatchObject({
        requestId: permission.id,
      });
      const completion = await backend.waitForPrompt(receipt.promptId);
      expect(completion.prompt.status).toBe("succeeded");
      expect(
        (await backend.getPermissionSnapshot({ rootSessionId: "root" }))
          .requests,
      ).toEqual([]);
      const recovered = await request(query, {
        headers: { "x-ohbaby-client-id": "client-refresh" },
      });
      expect(await recovered.json()).toMatchObject({
        snapshot: { requests: [], permissionRevision: 2 },
      });
      expect((await request("/v1/snapshot")).status).toBe(500);
    } finally {
      vi.restoreAllMocks();
      for (const controller of controllers) controller.abort();
      await app.dispose();
      await server.stop();
      await backend.dispose();
    }
  },
);

it("reinstalls a failed dedicated permission forwarder", async () => {
  const backend = fakeBackend();
  let fail: ((error: unknown) => void) | undefined;
  let subscriptions = 0;
  const unsubscribe = vi.fn();
  backend.subscribePermissionEvents = (_handler, onError): (() => void) => {
    subscriptions += 1;
    fail = onError;
    return unsubscribe;
  };
  const app = createDaemonServerApp({ backend, authToken: "permission-token" });
  await app.start();
  try {
    expect(subscriptions).toBe(1);
    fail?.(new Error("delivery interrupted"));
    await vi.waitUntil(() => subscriptions === 2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  } finally {
    await app.dispose();
  }
});

it("rejects unauthenticated, unregistered, stale epoch and A-to-B-to-A bindings through REST and RPC", async () => {
  const backend = fakeBackend();
  const respond = vi.fn(() => Promise.resolve());
  backend.respondPermission = respond;
  const app = createDaemonServerApp({ backend, authToken: "permission-token" });
  await app.start();
  try {
    expect((await app.app.request("/v1/permissions")).status).toBe(401);
    expect((await app.app.request("/v1/permissions", { headers })).status).toBe(
      409,
    );
    const registered = await app.app.request("/v1/clients", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId: "client-a",
        startupIntent: { resumeSessionId: "root" },
      }),
    });
    const initial =
      (await registered.json()) as import("ohbaby-sdk").UiPermissionBinding;
    await app.app.request("/v1/sessions/other/select", {
      method: "PATCH",
      headers,
    });
    const selected = await app.app.request("/v1/sessions/root/select", {
      method: "PATCH",
      headers,
    });
    const current =
      (await selected.json()) as import("ohbaby-sdk").UiPermissionBinding;
    expect(current.bindingGeneration).toBe(initial.bindingGeneration + 2);
    for (const context of [
      initial,
      { ...current, permissionEpoch: "old-epoch" },
      { ...current, rootSessionId: "other" },
    ]) {
      const query = new URLSearchParams({
        rootSessionId: context.rootSessionId ?? "",
        permissionEpoch: context.permissionEpoch,
        bindingGeneration: String(context.bindingGeneration),
      });
      expect(
        (
          await app.app.request(`/v1/permissions?${query.toString()}`, {
            headers,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await app.app.request("/v1/permissions/request", {
            method: "POST",
            headers,
            body: JSON.stringify({ response: { choiceId: "allow" }, context }),
          })
        ).status,
      ).toBe(409);
      const rpc = await app.app.request("/api/rpc", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "stale",
          clientId: "client-a",
          method: "respondPermission",
          params: ["request", { choiceId: "allow" }, context],
        }),
      });
      expect(await rpc.json()).toMatchObject({
        ok: false,
        error: { code: "PERMISSION_SCOPE_CHANGED" },
      });
    }
    expect(respond).not.toHaveBeenCalled();
  } finally {
    await app.dispose();
  }
});

interface PermissionValidationFixture {
  readonly directory: string;
  readonly backend: ReturnType<
    typeof import("ohbaby-agent").createInProcessUiBackendClient
  >;
  readonly binding: UiPermissionBinding;
  readonly otherBinding: UiPermissionBinding;
  register(
    clientId: string,
    rootSessionId: string,
  ): Promise<UiPermissionBinding>;
  query(
    context: UiPermissionBinding,
    clientId: string,
  ): Promise<UiPermissionSnapshot>;
  respond(
    transport: "REST" | "RPC",
    requestId: string,
    response: import("ohbaby-sdk").UiPermissionResponse,
    context?: UiPermissionBinding,
    clientId?: string,
  ): Promise<Record<string, unknown>>;
  start(): ReturnType<UiBackendClient["submitPromptAccepted"]>;
  assertNoExecution(): Promise<void>;
  executionContent(): Promise<string>;
  dispose(): Promise<void>;
}

async function realPermissionValidationFixture(
  options: {
    readonly count?: number;
    readonly sensitive?: boolean;
  } = {},
): Promise<PermissionValidationFixture> {
  const { mkdtemp, writeFile, readFile, rm, access } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createInProcessUiBackendClient } = await import("ohbaby-agent");
  const directory = await mkdtemp(path.join(tmpdir(), "permission-transport-"));
  await writeFile(path.join(directory, ".env"), "TEST_ONLY_VALUE=fixture\n");
  let step = 0;
  const backend = createInProcessUiBackendClient({
    workdir: directory,
    projectDirectory: directory,
    initialSnapshot: {
      activeSessionId: "root",
      sessions: index.map((session) => ({
        ...session,
        projectRoot: directory,
        messages: [],
      })),
      runs: [],
      permissions: [],
      status: { kind: "idle" },
    },
    llmClient: {
      config: {
        apiKeyEnv: "TEST_KEY",
        baseUrl: "https://invalid.test",
        interfaceProvider: "openai-compatible",
        maxTokens: 100,
        model: "fake-model",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        streamResponse() {
          const event =
            step++ === 0
              ? {
                  finishReason: "tool_calls" as const,
                  toolCallDeltas: Array.from(
                    { length: options.count ?? 1 },
                    (_, index) => ({
                      index,
                      id: `validation-call-${String(index)}`,
                      name: "bash",
                      argumentsDelta: JSON.stringify({
                        command: options.sensitive
                          ? "cat .env"
                          : "node -e \"require('node:fs').appendFileSync('never-run.txt','x')\"",
                      }),
                    }),
                  ),
                }
              : { finishReason: "stop" as const, textDelta: "done" };
          return Promise.resolve(
            (async function* (): AsyncGenerator<typeof event, void, unknown> {
              await Promise.resolve();
              yield event;
            })(),
          );
        },
      },
    },
  });
  const app = createDaemonServerApp({ backend, authToken: "permission-token" });
  await app.start();
  const register = async (
    clientId: string,
    rootSessionId: string,
  ): Promise<UiPermissionBinding> => {
    const response = await app.app.request("/v1/clients", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientId,
        startupIntent: { resumeSessionId: rootSessionId },
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as UiPermissionBinding;
  };
  const binding = await register("client-a", "root");
  const otherBinding = await register("client-other", "other");
  const respond = async (
    transport: "REST" | "RPC",
    requestId: string,
    response: import("ohbaby-sdk").UiPermissionResponse,
    context = binding,
    clientId = "client-a",
  ): Promise<Record<string, unknown>> => {
    const result = await app.app.request(
      transport === "REST" ? `/v1/permissions/${requestId}` : "/api/rpc",
      {
        method: "POST",
        headers: { ...headers, "x-ohbaby-client-id": clientId },
        body: JSON.stringify(
          transport === "REST"
            ? { response, context }
            : {
                id: "validation",
                clientId,
                method: "respondPermission",
                params: [requestId, response, context],
              },
        ),
      },
    );
    return (await result.json()) as Record<string, unknown>;
  };
  return {
    directory,
    backend,
    binding,
    otherBinding,
    register,
    async query(context, clientId): Promise<UiPermissionSnapshot> {
      const params = new URLSearchParams({
        permissionEpoch: context.permissionEpoch,
        rootSessionId: context.rootSessionId ?? "",
        bindingGeneration: String(context.bindingGeneration),
      });
      const response = await app.app.request(
        `/v1/permissions?${params.toString()}`,
        { headers: { ...headers, "x-ohbaby-client-id": clientId } },
      );
      const body = (await response.json()) as {
        snapshot: UiPermissionSnapshot;
        error?: { code?: string; message: string };
      };
      if (!response.ok)
        throw Object.assign(
          new Error(body.error?.message ?? "Query failed"),
          body.error,
        );
      return body.snapshot;
    },
    respond,
    start(): ReturnType<UiBackendClient["submitPromptAccepted"]> {
      return backend.submitPromptAccepted("Run approval validation", {
        sessionId: "root",
      });
    },
    async assertNoExecution(): Promise<void> {
      await expect(
        access(path.join(directory, "never-run.txt")),
      ).rejects.toThrow();
    },
    executionContent(): Promise<string> {
      return readFile(path.join(directory, "never-run.txt"), "utf8");
    },
    async dispose(): Promise<void> {
      await app.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each([false, true])(
  "keeps real approvals pending after invalid REST/RPC choices, sensitive=%s",
  async (sensitive) => {
    const fixture = await realPermissionValidationFixture({ sensitive });
    try {
      const requested = new Promise<import("ohbaby-sdk").UiPermissionRequest>(
        (resolve) => {
          const stop = fixture.backend.subscribePermissionEvents((event) => {
            if (event.type === "permission.requested") {
              stop();
              resolve(event.request);
            }
          });
        },
      );
      const receipt = await fixture.start();
      const request = await requested;
      if (sensitive)
        expect(
          request.choices.some((choice) => choice.id === "allow_always"),
        ).toBe(false);
      const invalid = [
        { choiceId: "unknown" },
        { choiceId: "cancel" },
        { choiceId: "allow_always", remember: false },
        { choiceId: "reject", remember: true },
        ...(sensitive ? [{ choiceId: "allow_always" }] : []),
      ];
      for (const transport of ["REST", "RPC"] as const) {
        for (const response of invalid) {
          expect(
            await fixture.respond(transport, request.id, response),
          ).toMatchObject({
            ok: false,
            error: { code: "INVALID_PERMISSION_CHOICE" },
          });
          expect(
            (
              await fixture.backend.getPermissionSnapshot(fixture.binding)
            ).requests.map((item) => item.id),
          ).toEqual([request.id]);
        }
      }
      expect(
        await fixture.respond("REST", request.id, { choiceId: "reject" }),
      ).toMatchObject({ ok: true });
      await fixture.backend.waitForPrompt(receipt.promptId);
      for (const transport of ["REST", "RPC"] as const) {
        expect(
          await fixture.respond(
            transport,
            request.id,
            { choiceId: "allow_once" },
            fixture.otherBinding,
            "client-other",
          ),
        ).toMatchObject({
          ok: false,
          error: { code: "PERMISSION_SCOPE_CHANGED" },
        });
        expect(
          await fixture.respond(transport, request.id, {
            choiceId: "allow_once",
          }),
        ).toMatchObject({ ok: true });
      }
      expect(
        (await fixture.backend.getPermissionSnapshot(fixture.binding)).requests,
      ).toEqual([]);
      expect(
        (await fixture.backend.getSnapshot()).permission?.sessionRules,
      ).toEqual([]);
      await fixture.assertNoExecution();
    } finally {
      await fixture.dispose();
    }
  },
);

it("rejects evicted real terminal IDs through REST/RPC without reviving or leaking their old scope", async () => {
  const fixture = await realPermissionValidationFixture({ count: 1026 });
  try {
    let firstId: string | undefined;
    let seen = 0;
    let last!: (request: import("ohbaby-sdk").UiPermissionRequest) => void;
    const lastPending = new Promise<import("ohbaby-sdk").UiPermissionRequest>(
      (resolve) => {
        last = resolve;
      },
    );
    const errors: unknown[] = [];
    const stop = fixture.backend.subscribePermissionEvents((event) => {
      if (event.type !== "permission.requested") return;
      firstId ??= event.request.id;
      seen += 1;
      if (seen === 1026) {
        last(event.request);
        return;
      }
      void fixture.backend
        .respondPermission(
          event.request.id,
          { choiceId: "reject" },
          fixture.binding,
        )
        .catch((error: unknown) => {
          errors.push(error);
        });
    });
    const receipt = await fixture.start();
    const pending = await lastPending;
    stop();
    expect(errors).toEqual([]);
    expect(firstId).toBeTypeOf("string");
    for (const transport of ["REST", "RPC"] as const) {
      for (const [context, clientId] of [
        [fixture.binding, "client-a"],
        [fixture.otherBinding, "client-other"],
      ] as const) {
        const result = await fixture.respond(
          transport,
          firstId ?? "missing",
          { choiceId: "allow_always" },
          context,
          clientId,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "PERMISSION_NOT_PENDING" },
        });
        expect(JSON.stringify(result)).not.toContain("validation-call-0");
      }
    }
    expect(
      (
        await fixture.backend.getPermissionSnapshot(fixture.binding)
      ).requests.map((item) => item.id),
    ).toEqual([pending.id]);
    expect(
      (await fixture.backend.getSnapshot()).permission?.sessionRules,
    ).toEqual([]);
    await fixture.respond("RPC", pending.id, { choiceId: "reject" });
    await fixture.backend.waitForPrompt(receipt.promptId);
    await fixture.assertNoExecution();
  } finally {
    await fixture.dispose();
  }
}, 30_000);

function nextValidationApproval(
  backend: UiBackendClient,
): Promise<import("ohbaby-sdk").UiPermissionRequest> {
  return new Promise((resolve) => {
    const stop = backend.subscribePermissionEvents((event) => {
      if (event.type === "permission.requested") {
        stop();
        resolve(event.request);
      }
    });
  });
}

it.each([
  ["REST", "allow_once", "allow_once"],
  ["RPC", "allow_once", "allow_once"],
  ["REST", "allow_once", "reject"],
  ["RPC", "allow_once", "reject"],
  ["REST", "reject", "allow_once"],
  ["RPC", "reject", "allow_once"],
] as const)(
  "commits one real decision when %s %s wins over a concurrent %s answer",
  async (firstTransport, firstChoice, secondChoice) => {
    const fixture = await realPermissionValidationFixture();
    try {
      const requested = nextValidationApproval(fixture.backend);
      const receipt = await fixture.start();
      const request = await requested;
      const decisions: import("ohbaby-sdk").UiPermissionEvent[] = [];
      const stop = fixture.backend.subscribePermissionEvents((event) => {
        if (event.type === "permission.resolved") decisions.push(event);
      });
      const originalIndex = fixture.backend.getSessionIndex.bind(
        fixture.backend,
      );
      const gates: (() => void)[] = [];
      fixture.backend.getSessionIndex = async (): ReturnType<
        UiBackendClient["getSessionIndex"]
      > => {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return originalIndex();
      };
      const first = fixture.respond(firstTransport, request.id, {
        choiceId: firstChoice,
      });
      await vi.waitFor(() => {
        expect(gates).toHaveLength(1);
      });
      const second = fixture.respond(
        firstTransport === "REST" ? "RPC" : "REST",
        request.id,
        { choiceId: secondChoice },
      );
      await vi.waitFor(() => {
        expect(gates).toHaveLength(2);
      });
      fixture.backend.getSessionIndex = originalIndex;
      gates[0]();
      expect(await first).toMatchObject({ ok: true });
      gates[1]();
      expect(await second).toMatchObject({ ok: true });
      await fixture.backend.waitForPrompt(receipt.promptId);
      stop();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        requestId: request.id,
        reason: firstChoice === "reject" ? "reject" : "once",
      });
      expect(
        (await fixture.query(fixture.binding, "client-a")).requests,
      ).toEqual([]);
      if (firstChoice === "reject") await fixture.assertNoExecution();
      else expect(await fixture.executionContent()).toBe("x");
      expect(
        (await fixture.backend.getSnapshot()).permission?.sessionRules,
      ).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  },
);

it("keeps client A unready after a failed approval query while B answers, then A explicitly recovers empty", async () => {
  const { createPermissionSync } = await import("ohbaby-sdk");
  const fixture = await realPermissionValidationFixture();
  const bindingB = await fixture.register("client-b", "root");
  const a = createPermissionSync({
    limits: { maxAttempts: 1 },
    query: (binding) => fixture.query(binding, "client-a"),
  });
  const b = createPermissionSync({
    query: (binding) => fixture.query(binding, "client-b"),
  });
  const stopEvents = fixture.backend.subscribePermissionEvents((event) => {
    a.receive(event);
    b.receive(event);
  });
  try {
    const requested = nextValidationApproval(fixture.backend);
    const receipt = await fixture.start();
    const request = await requested;
    const originalQuery = fixture.backend.getPermissionSnapshot.bind(
      fixture.backend,
    );
    fixture.backend.getPermissionSnapshot = (): Promise<UiPermissionSnapshot> =>
      Promise.reject(new Error("Client A query failed"));
    a.begin(fixture.binding, 1);
    await vi.waitFor(() => {
      expect(a.getState().status).toBe("error");
    });
    expect(
      (await originalQuery(fixture.binding)).requests.map((item) => item.id),
    ).toEqual([request.id]);
    fixture.backend.getPermissionSnapshot = originalQuery;
    b.begin(bindingB, 1);
    await vi.waitFor(() => {
      expect(b.getState().status).toBe("ready");
    });
    expect(
      await fixture.respond(
        "RPC",
        request.id,
        { choiceId: "allow_once" },
        bindingB,
        "client-b",
      ),
    ).toMatchObject({ ok: true });
    await fixture.backend.waitForPrompt(receipt.promptId);
    expect(a.getState().status).toBe("error");
    expect(b.getState().requests).toEqual([]);
    a.retry();
    await vi.waitFor(() => {
      expect(a.getState().status).toBe("ready");
    });
    expect(a.getState().requests).toEqual([]);
    expect(a.getState().permissionRevision).toBe(2);
    expect(await fixture.executionContent()).toBe("x");
  } finally {
    stopEvents();
    a.dispose();
    b.dispose();
    await fixture.dispose();
  }
});

it("rejects a real approval through REST/RPC routed to another workspace", async () => {
  const { createDaemonHttpServer } =
    await import("../runtime/daemon/server.js");
  const { realpath } = await import("node:fs/promises");
  const a = await realPermissionValidationFixture();
  const b = await realPermissionValidationFixture();
  const secondWorkspace = await realpath(b.directory);
  const server = createDaemonHttpServer({
    authToken: "permission-token",
    backend: a.backend,
    port: 0,
    scopeRoot: await realpath(a.directory),
    createWorkspaceBackend: (scope) => {
      expect(scope).toBe(secondWorkspace);
      return { ...b.backend, dispose: (): Promise<void> => Promise.resolve() };
    },
  });
  await server.start();
  const request = (
    directory: string,
    path: string,
    body: unknown,
  ): Promise<Response> =>
    fetch(server.url + path, {
      method: "POST",
      headers: { ...headers, "x-ohbaby-directory": directory },
      body: JSON.stringify(body),
    });
  try {
    const registered = await request(b.directory, "/v1/clients", {
      clientId: "client-a",
      startupIntent: { resumeSessionId: "root" },
    });
    const bindingB = (await registered.json()) as UiPermissionBinding;
    const pendingA = nextValidationApproval(a.backend);
    const pendingB = nextValidationApproval(b.backend);
    const receiptA = await a.start();
    const receiptB = await b.start();
    const approvalA = await pendingA;
    const approvalB = await pendingB;
    for (const transport of ["REST", "RPC"] as const) {
      for (const context of [a.binding, bindingB]) {
        const response = await request(
          b.directory,
          transport === "REST" ? `/v1/permissions/${approvalA.id}` : "/api/rpc",
          transport === "REST"
            ? { response: { choiceId: "allow_always" }, context }
            : {
                id: "wrong-workspace",
                clientId: "client-a",
                method: "respondPermission",
                params: [approvalA.id, { choiceId: "allow_always" }, context],
              },
        );
        expect(await response.json()).toMatchObject({
          ok: false,
          error: {
            code:
              context === a.binding
                ? "PERMISSION_SCOPE_CHANGED"
                : "PERMISSION_NOT_PENDING",
          },
        });
      }
    }
    expect(
      (await a.backend.getPermissionSnapshot(a.binding)).requests.map(
        (item) => item.id,
      ),
    ).toEqual([approvalA.id]);
    expect(
      (await b.backend.getPermissionSnapshot(b.binding)).requests.map(
        (item) => item.id,
      ),
    ).toEqual([approvalB.id]);
    for (const fixture of [a, b]) {
      expect(
        (await fixture.backend.getSnapshot()).permission?.sessionRules,
      ).toEqual([]);
      await fixture.assertNoExecution();
    }
    await a.backend.respondPermission(
      approvalA.id,
      { choiceId: "reject" },
      a.binding,
    );
    await b.backend.respondPermission(
      approvalB.id,
      { choiceId: "reject" },
      b.binding,
    );
    await Promise.all([
      a.backend.waitForPrompt(receiptA.promptId),
      b.backend.waitForPrompt(receiptB.promptId),
    ]);
  } finally {
    await server.stop();
    await a.dispose();
    await b.dispose();
  }
});
