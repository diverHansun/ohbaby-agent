/* eslint-disable @typescript-eslint/unbound-method -- assertions inspect fixture spies without invoking them */
import type { UiPromptQueueExecutionPort } from "ohbaby-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiBackendClient,
  UiEvent,
  UiSessionView,
  UiSessionRecoveryClient,
} from "ohbaby-sdk";
import { createDaemonHttpServer } from "../runtime/daemon/server.js";
import { createRemoteUiBackendClient } from "../protocols/jsonrpc/client.js";
import { InMemoryPromptSubmissionStore } from "../../../ohbaby-agent/src/runtime/prompt-scheduler/in-memory-store.js";

const epoch = "source-epoch";
const stamp = "2026-09-25T00:00:00Z";
const roots = ["root", "other"].map((id) => ({
  id,
  title: id,
  createdAt: stamp,
  updatedAt: stamp,
}));
function baseline(sessionId = "root"): UiSessionView {
  return {
    version: {
      runtimeEpoch: epoch,
      sessionId,
      viewGeneration: "source-generation",
      sessionRevision: 7,
    },
    session: {
      ...roots[0],
      id: sessionId,
      messages: [
        {
          id: "real-message",
          runId: "real-run",
          role: "assistant",
          createdAt: stamp,
          parts: [{ type: "text", id: "real-part", text: "source" }],
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
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type RecoveryBackend = UiBackendClient &
  UiSessionRecoveryClient &
  UiPromptQueueExecutionPort;
interface SetupResult {
  backend: RecoveryBackend;
  server: ReturnType<typeof createDaemonHttpServer>;
  binding: Record<string, unknown>;
  headers: Record<string, string>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  emit: (event: UiEvent) => void;
}
async function setup(
  options: { unsupported?: boolean; conversation?: boolean } = {},
): Promise<SetupResult> {
  const listeners = new Set<(event: UiEvent) => void>();
  const source: UiSessionRecoveryClient = {
    getSessionView: (input) => Promise.resolve(baseline(input.sessionId)),
    getSessionHistory: (input) =>
      Promise.resolve({
        version: baseline(input.sessionId).version,
        messages: baseline(input.sessionId).session.messages,
        prompts: [],
        hasMore: false,
        reasoningMissing: false,
      }),
    getSessionControl: (input) =>
      Promise.resolve({
        runtimeEpoch: epoch,
        sessionId: input.sessionId,
        rootSessionId: input.sessionId,
        runId: "real-run",
        driver: "user",
      }),
    getPromptReceipt: (input) =>
      Promise.resolve({
        runtimeEpoch: epoch,
        clientRequestId: input.clientRequestId,
        receipt: {
          clientRequestId: input.clientRequestId,
          promptId: "original-prompt",
          userMessageId: "user-message",
          sessionId: "root",
          status: "running",
          createdAt: stamp,
        },
      }),
  };
  const backend = {
    ...(options.unsupported ? {} : source),
    ...(options.conversation
      ? {
          getSubagentConversationView: () =>
            Promise.resolve({
              rootSessionId: "root",
              subagentId: "logical-child",
              view: baseline("child"),
              messages: [],
              history: { hasMore: false, hasLater: false },
              executions: [],
              anchorFound: false,
              readOnly: true as const,
            }),
        }
      : {}),
    initializeSession: vi.fn(() =>
      Promise.reject(new Error("chat seed unavailable")),
    ),
    getSessionIndex: () =>
      Promise.resolve([
        ...roots,
        { ...roots[0], id: "child", parentId: "root", isSubagent: true },
      ]),
    getSnapshot: vi.fn(() =>
      Promise.reject(new Error("chat snapshot must not be queried")),
    ),
    getPermissionSnapshot: (input: { rootSessionId: string | null }) =>
      Promise.resolve({
        permissionEpoch: epoch,
        rootSessionId: input.rootSessionId,
        permissionRevision: 0,
        requests: [],
      }),
    subscribePermissionEvents: (): (() => void) => (): void => undefined,
    subscribeEvents: (handler: (event: UiEvent) => void): (() => void) => {
      listeners.add(handler);
      return (): void => {
        listeners.delete(handler);
      };
    },
    abortRun: vi.fn(() => Promise.resolve()),
  } as unknown as UiBackendClient &
    UiSessionRecoveryClient &
    UiPromptQueueExecutionPort;
  const server = createDaemonHttpServer({
    backend,
    authToken: "recovery-token",
    host: "127.0.0.1",
    port: 0,
  });
  await server.start();
  cleanups.push(() => server.stop());
  const headers = {
    authorization: "Bearer recovery-token",
    "content-type": "application/json",
    "x-ohbaby-client-id": "client",
  };
  const url = `http://127.0.0.1:${String(server.port)}`;
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, { ...init, headers });
  const registration = await request("/v1/clients", {
    method: "POST",
    body: JSON.stringify({
      clientId: "client",
      startupIntent: { resumeSessionId: "root" },
    }),
  });
  const binding = (await registration.json()) as Record<string, unknown>;
  return {
    backend,
    server,
    binding,
    headers,
    request,
    emit: (event: UiEvent): void => {
      for (const listener of listeners) listener(event);
    },
  };
}
const query = `runtimeEpoch=${epoch}&bindingGeneration=1`;

describe("source session recovery HTTP/RPC/SSE", () => {
  it("marks malformed prompt input as definitely rejected before admission", async () => {
    const { request, backend } = await setup();
    backend.submitPromptAccepted = vi.fn(() =>
      Promise.reject(new Error("must not admit")),
    );
    const response = await request("/v1/prompts", {
      method: "POST",
      body: JSON.stringify({ text: "", clientRequestId: "empty" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "PROMPT_SUBMISSION_REJECTED" },
    });
    expect(backend.submitPromptAccepted).not.toHaveBeenCalled();
  });

  it("returns an unknown admission failure as 500 and preserves the committed receipt", async () => {
    const { request, backend } = await setup();
    const store = new InMemoryPromptSubmissionStore();
    backend.submitPromptAccepted = async (
      text,
      options,
    ): ReturnType<UiBackendClient["submitPromptAccepted"]> => {
      await store.accept({
        scopeKey: "test",
        promptId: "persisted",
        clientRequestId: options?.clientRequestId ?? "missing",
        sessionId: "root",
        text,
        userMessageId: "persisted-user",
        maxQueuedPrompts: 100,
      });
      throw new Error("response lost after durable acceptance");
    };
    backend.getPromptReceipt = async (
      input,
    ): ReturnType<UiSessionRecoveryClient["getPromptReceipt"]> => {
      const record = await store.getByClientRequestId(
        "test",
        input.clientRequestId,
      );
      return {
        runtimeEpoch: epoch,
        clientRequestId: input.clientRequestId,
        receipt: record
          ? {
              promptId: record.promptId,
              clientRequestId: record.clientRequestId,
              sessionId: record.sessionId,
              userMessageId: record.userMessageId,
              status: record.status,
              createdAt: new Date(record.createdAt).toISOString(),
            }
          : null,
      };
    };
    const response = await request("/v1/prompts", {
      method: "POST",
      body: JSON.stringify({
        text: "intent",
        sessionId: "root",
        clientRequestId: "persisted-request",
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { message: "response lost after durable acceptance" },
    });
    const receipt = await request(
      `/v1/prompts/receipt?${query}&sessionId=root&clientRequestId=persisted-request`,
    );
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      result: { receipt: { promptId: "persisted", status: "queued" } },
    });
  });

  it("transports the source version and exact identities through REST and RPC without snapshot reads", async () => {
    const { request, binding, backend } = await setup();
    expect(binding).toMatchObject({
      runtimeEpoch: epoch,
      permissionEpoch: epoch,
      sessionRecoveryVersion: 1,
    });
    const response = await request(`/v1/sessions/root/view?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      view: { ...baseline(), bindingGeneration: 1 },
    });
    for (const [method, path, key] of [
      ["getSessionHistory", "history?limit=1&", "history"],
      ["getSessionControl", "control?", "control"],
    ] as const) {
      const rest = await request(`/v1/sessions/root/${path}${query}`);
      expect(rest.status).toBe(200);
      const rpc = await request("/api/rpc", {
        method: "POST",
        body: JSON.stringify({
          id: method,
          clientId: "client",
          method,
          params: [
            {
              sessionId: "root",
              runtimeEpoch: epoch,
              bindingGeneration: 1,
              ...(method === "getSessionHistory" ? { limit: 1 } : {}),
            },
          ],
        }),
      });
      expect(rpc.status).toBe(200);
      expect(((await rpc.json()) as { result: unknown }).result).toEqual(
        ((await rest.json()) as Record<string, unknown>)[key],
      );
    }
    expect(backend.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects another root, child and changed binding both before and after an asynchronous source read", async () => {
    const { request, backend } = await setup();
    expect((await request(`/v1/sessions/child/view?${query}`)).status).toBe(
      409,
    );
    expect((await request(`/v1/sessions/other/view?${query}`)).status).toBe(
      409,
    );
    let release!: (value: UiSessionView) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    backend.getSessionView = (): Promise<UiSessionView> => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = request(`/v1/sessions/root/view?${query}`);
    await started;
    expect(
      (await request("/v1/sessions/other/select", { method: "PATCH" })).status,
    ).toBe(200);
    release(baseline());
    expect((await pending).status).toBe(409);
  });

  it("looks up an unknown-submit receipt in its registered workspace without selecting its old root", async () => {
    const { request } = await setup();
    await request("/v1/sessions/other/select", { method: "PATCH" });
    const response = await request(
      `/v1/prompts/receipt?clientRequestId=original-request&runtimeEpoch=${epoch}&bindingGeneration=2`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        runtimeEpoch: epoch,
        bindingGeneration: 2,
        receipt: { sessionId: "root", promptId: "original-prompt" },
      },
    });
    const control = await request(
      `/v1/sessions/other/control?runtimeEpoch=${epoch}&bindingGeneration=2`,
    );
    expect(control.status).toBe(200);
  });

  it("rejects Stop when the exact run expires after its control check", async () => {
    const { request, backend } = await setup();
    vi.mocked(backend.abortRun).mockImplementation(
      () => Promise.resolve(false) as unknown as Promise<void>,
    );
    const response = await request("/v1/sessions/root/abort", {
      method: "POST",
      body: JSON.stringify({
        runId: "real-run",
        runtimeEpoch: epoch,
        bindingGeneration: 1,
      }),
    });
    expect(response.status).toBe(409);
  });

  it("uses independent control and requires the exact requested run for Stop", async () => {
    const { request, backend } = await setup();
    const body = {
      runId: "real-run",
      runtimeEpoch: epoch,
      bindingGeneration: 1,
    };
    expect(
      (
        await request("/v1/sessions/root/abort", {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
    expect(backend.abortRun).toHaveBeenCalledWith("real-run");
    expect(
      (
        await request("/v1/sessions/root/abort", {
          method: "POST",
          body: JSON.stringify({ ...body, runId: "stale-run" }),
        })
      ).status,
    ).toBe(409);
    expect(backend.getSnapshot).not.toHaveBeenCalled();
  });

  it("publishes every selected-session revision with the original version and registered binding", async () => {
    const { request, emit } = await setup();
    const response = await request("/v1/events");
    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!reader) throw new Error("missing SSE body");
    try {
      const hello = new TextDecoder().decode((await reader.read()).value);
      expect(hello).toContain('"runtimeEpoch":"source-epoch"');
      expect(hello).toContain('"sessionRecoveryVersion":1');
      emit({
        type: "session.changed",
        version: {
          ...baseline().version,
          sessionId: "other",
          sessionRevision: 8,
        },
      });
      emit({
        type: "session.changed",
        version: { ...baseline().version, sessionRevision: 8 },
      });
      emit({
        type: "session.changed",
        version: { ...baseline().version, sessionRevision: 9 },
        historyInvalidated: true,
      });
      let frames = "";
      while (!frames.includes('"sessionRevision":9'))
        frames += new TextDecoder().decode((await reader.read()).value);
      expect(frames).not.toContain('"sessionId":"other"');
      expect(frames).toContain('"sessionRevision":8');
      expect(frames).toContain('"bindingGeneration":1');
    } finally {
      await reader.cancel();
    }
  });

  it("reports unsupported recovery without a snapshot fallback and keeps permissions usable", async () => {
    const { request, binding, backend, server } = await setup({
      unsupported: true,
    });
    expect(binding).toMatchObject({ sessionRecoveryVersion: 0 });
    expect((await request(`/v1/sessions/root/view?${query}`)).status).toBe(426);
    const permission = await request(
      `/v1/permissions?rootSessionId=root&permissionEpoch=${epoch}&bindingGeneration=1`,
    );
    expect(permission.status).toBe(200);
    const client = createRemoteUiBackendClient({
      port: server.port,
      authToken: "recovery-token",
      startupIntent: { resumeSessionId: "root" },
    });
    cleanups.push(() => client.dispose());
    await expect(
      client.getSessionView({
        sessionId: "root",
        runtimeEpoch: undefined,
        bindingGeneration: undefined,
      }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_UNSUPPORTED" });
    expect(backend.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a root removed while the source query is pending", async () => {
    const { request, backend } = await setup();
    let release!: (view: UiSessionView) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    backend.getSessionView = (): Promise<UiSessionView> => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = request(`/v1/sessions/root/view?${query}`);
    await started;
    backend.getSessionIndex = (): ReturnType<
      UiBackendClient["getSessionIndex"]
    > => Promise.resolve(roots.filter((root) => root.id !== "root"));
    release(baseline());
    expect((await pending).status).toBe(409);
  });

  it("announces a fresh binding when index invalidation removes the selected root", async () => {
    const { request, backend, emit } = await setup();
    const response = await request("/v1/events");
    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!reader) throw new Error("missing SSE body");
    try {
      await reader.read();
      backend.getSessionIndex = (): ReturnType<
        UiBackendClient["getSessionIndex"]
      > => Promise.resolve(roots.filter((root) => root.id !== "root"));
      emit({ type: "session.index.invalidated", selectedSessionId: "other" });
      let frames = "";
      while (!frames.includes('"bindingGeneration":2'))
        frames += new TextDecoder().decode((await reader.read()).value);
      expect(frames).toContain('"rootSessionId":null');
      expect(frames).toContain('"runtimeEpoch":"source-epoch"');
      expect(backend.initializeSession).toHaveBeenCalledWith("root");
    } finally {
      await reader.cancel();
    }
  });

  it("keeps the current hello binding across replayed index and stale command selection events", async () => {
    const { request, headers, server, emit } = await setup();
    const original = await request("/v1/events");
    const originalReader = original.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!originalReader) throw new Error("missing initial SSE");
    await originalReader.read();
    emit({ type: "session.index.invalidated", selectedSessionId: "root" });
    await request("/api/rpc", {
      method: "POST",
      body: JSON.stringify({
        id: "resume-rpc",
        clientId: "client",
        method: "executeCommand",
        params: [
          {
            commandId: "resume",
            path: ["resume"],
            argv: ["root"],
            clientInvocationId: "resume-root",
            raw: "/resume root",
            rawArgs: "root",
          },
        ],
      }),
    });
    await originalReader.cancel();
    await request("/v1/sessions/other/select", { method: "PATCH" });
    const late: UiEvent = {
      type: "command.result.delivered",
      clientInvocationId: "resume-root",
      commandRunId: "late-command",
      timestamp: 1,
      action: { kind: "session.selected", data: { choiceId: "root" } },
    };
    emit(late);
    emit({ type: "model.invalidated" });
    const replay = await fetch(
      `http://127.0.0.1:${String(server.port)}/v1/events`,
      { headers: { ...headers, "last-event-id": "0" } },
    );
    const reader = replay.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!reader) throw new Error("missing replay SSE");
    try {
      let frames = "";
      while (!frames.includes('"model.invalidated"'))
        frames += new TextDecoder().decode((await reader.read()).value);
      const events = frames
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              type: string;
              rootSessionId?: string;
              event?: UiEvent;
            },
        );
      expect(events[0]).toMatchObject({
        type: "hello",
        rootSessionId: "other",
        bindingGeneration: 3,
      });
      const index = events.flatMap((event) =>
        event.event?.type === "session.index.invalidated" ? [event.event] : [],
      );
      expect(index).toHaveLength(1);
      expect(index[0]?.selectedSessionId).toBe("other");
      expect(
        events.some(
          (event) =>
            event.event?.type === "command.result.delivered" &&
            event.event.action?.kind === "session.selected",
        ),
      ).toBe(false);
      // The same obsolete command arriving on the live connection must also be harmless.
      emit(late);
      let live = "";
      while (!live.includes('"late-command"'))
        live += new TextDecoder().decode((await reader.read()).value);
      expect(live).not.toContain('"session.selected"');
    } finally {
      await reader.cancel();
    }
  });

  it("remote hello requests source recovery and never creates snapshot replacement on resync", async () => {
    const { server, emit, backend } = await setup();
    const client = createRemoteUiBackendClient({
      port: server.port,
      authToken: "recovery-token",
      clientId: "remote",
      startupIntent: { resumeSessionId: "root" },
    });
    cleanups.push(() => client.dispose());
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });
    await vi.waitFor(() => {
      expect(
        events.some((event) => event.type === "session.resync-required"),
      ).toBe(true);
    });
    await expect(
      client.getSessionView({
        sessionId: "root",
        runtimeEpoch: undefined,
        bindingGeneration: undefined,
      }),
    ).resolves.toMatchObject({
      version: baseline().version,
      bindingGeneration: 1,
    });
    emit({
      type: "session.changed",
      version: { ...baseline().version, sessionRevision: 8 },
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "session.changed")).toBe(
        true,
      );
    });
    expect(events.some((event) => event.type === "snapshot.replaced")).toBe(
      false,
    );
    expect(backend.getSnapshot).not.toHaveBeenCalled();
  });
});

describe("readonly execution transports", () => {
  it("shares REST/RPC root-bound reads and rejects another selected root", async () => {
    const { request, backend } = await setup();
    const execution = {
      executionId: "execution",
      subagentId: "agent",
      rootSessionId: "root",
      rootRunId: "run",
      status: "running" as const,
      createdAt: 1,
      updatedAt: 2,
      resultStored: false,
      delivery: "none" as const,
    };
    backend.listSubagentExecutions = vi.fn().mockResolvedValue({
      executions: [execution],
      hasMore: false,
      waiting: true,
      approvalBlocked: false,
      activeCount: 1,
      completedCount: 0,
    });
    backend.getSubagentExecutionView = vi.fn().mockResolvedValue({
      execution,
      messages: [],
      history: { hasMore: false },
      readOnly: true,
      reasoningMissing: false,
    });
    const list = await request(`/v1/sessions/root/subagents?${query}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      result: { executions: [execution], waiting: true },
    });
    const rest = await request(
      `/v1/sessions/root/subagents/execution?${query}`,
    );
    expect(rest.status).toBe(200);
    const rpc = await request("/api/rpc", {
      method: "POST",
      body: JSON.stringify({
        id: "read",
        clientId: "client",
        method: "getSubagentExecutionView",
        params: [
          {
            rootSessionId: "root",
            executionId: "execution",
            runtimeEpoch: epoch,
            bindingGeneration: 1,
          },
        ],
      }),
    });
    expect(await rpc.json()).toMatchObject({
      ok: true,
      result: { execution, readOnly: true },
    });
    expect(
      (await request(`/v1/sessions/other/subagents?${query}`)).status,
    ).toBe(409);
    expect(
      (await request(`/v1/sessions/root/subagents?${query}&limit=201`)).status,
    ).toBe(400);
  });
  it("authorizes one conversation watch and releases replaced or root-switched watches", async () => {
    const { request, backend, binding } = await setup({ conversation: true });
    expect(binding.subagentConversationVersion).toBe(1);
    const execution = {
      executionId: "execution",
      subagentId: "logical-child",
      rootSessionId: "root",
      rootRunId: "root-run",
      status: "running" as const,
      createdAt: 1,
      updatedAt: 1,
      resultStored: false,
      delivery: "none" as const,
    };
    backend.getSubagentConversationView = vi.fn(() =>
      Promise.resolve({
        rootSessionId: "root",
        subagentId: "logical-child",
        view: baseline("child"),
        messages: [],
        history: { hasMore: false, hasLater: false },
        executions: [execution],
        anchorFound: false,
        readOnly: true as const,
      }),
    );
    backend.retainSubagentConversation = vi.fn(() => Promise.resolve());
    backend.releaseSubagentConversation = vi.fn(() => Promise.resolve());
    const path = "/v1/sessions/root/subagents/logical-child/conversation";
    const read = await request(`${path}?${query}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      result: { view: { bindingGeneration: 1 } },
    });
    const watch = async (): Promise<{ watchId: string }> => {
      const response = await request(`${path}/watch`, {
        method: "POST",
        body: JSON.stringify({
          runtimeEpoch: epoch,
          bindingGeneration: 1,
        }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: { watchId: string } })
        .result;
    };
    const first = await watch();
    const second = await watch();
    expect(first.watchId).not.toBe(second.watchId);
    expect(backend.retainSubagentConversation).toHaveBeenCalledTimes(2);
    expect(backend.releaseSubagentConversation).toHaveBeenCalledWith(
      expect.objectContaining({ watchId: first.watchId }),
    );
    const staleClose = await request(
      `${path}/watch?${query}&watchId=${first.watchId}`,
      { method: "DELETE" },
    );
    expect(staleClose.status).toBe(200);
    expect(backend.releaseSubagentConversation).toHaveBeenCalledTimes(1);
    await request("/v1/sessions/other/select", { method: "PATCH" });
    expect(backend.releaseSubagentConversation).toHaveBeenCalledWith(
      expect.objectContaining({ watchId: second.watchId }),
    );
    expect((await request(`${path}?${query}`)).status).toBe(409);
    expect(
      (
        await request(
          `/v1/sessions/other/subagents/logical-child/conversation?runtimeEpoch=${epoch}&bindingGeneration=2`,
        )
      ).status,
    ).toBe(409);
  });

  it("drops an execution response when the root binding changes during the read", async () => {
    const { request, backend } = await setup();
    let release: (
      value: import("ohbaby-sdk").UiSubagentExecutionList,
    ) => void = () => undefined;
    let announce: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    backend.listSubagentExecutions = () => {
      announce();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = request(`/v1/sessions/root/subagents?${query}`);
    await started;
    expect(
      (await request("/v1/sessions/other/select", { method: "PATCH" })).status,
    ).toBe(200);
    release({
      executions: [],
      hasMore: false,
      waiting: false,
      approvalBlocked: false,
      activeCount: 0,
      completedCount: 0,
    });
    expect((await pending).status).toBe(409);
  });
});
