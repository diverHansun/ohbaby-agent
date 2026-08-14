import { describe, expect, it } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCompactSessionResult,
  UiCompactSessionUsage,
  UiConnectModelInput,
  UiConnectModelResult,
  UiContextWindowUsage,
  UiEvent,
  UiEventHandler,
  UiPermissionState,
  UiProbeModelContextWindowInput,
  UiSetSearchApiKeyResult,
  UiSetSearchApiKeyInput,
  UiSlashCommandInvocation,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { createDaemonServerApp } from "ohbaby-server";
import { createOhbabyWebRuntime } from "./client.js";
import type { OhbabyBootstrapConfig } from "./wire.js";

const timestamp = "2026-06-12T00:00:00.000Z";
const authToken = "token_1";

function emptySnapshot(): UiSnapshot {
  return {
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
  };
}

function compactUsage(): UiCompactSessionUsage {
  return {
    contextLimit: 100,
    currentTokens: 1,
    modelId: "fake-model",
    remainingTokens: 99,
    usageRatio: 0.01,
  };
}

function compactResult(): UiCompactSessionResult {
  const usage = compactUsage();
  return {
    sessionId: "session_1",
    status: "not-needed",
    usageAfter: usage,
    usageBefore: usage,
  };
}

function connectModelResult(): UiConnectModelResult {
  return {
    apiKeyEnv: "FAKE_API_KEY",
    baseUrl: "https://example.invalid/v1",
    contextWindowSource: "default",
    contextWindowTokens: 100,
    envPath: ".env",
    interfaceProvider: "openai-compatible",
    model: "fake-model",
    modelJsonPath: "model.json",
    provider: "fake",
    saved: true,
  };
}

function setSearchApiKeyResult(): UiSetSearchApiKeyResult {
  return {
    apiKeyEnv: "TAVILY_API_KEY",
    envPath: ".env",
    provider: "tavily",
    searchJsonPath: "search.json",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class FakeBackend implements UiBackendClient {
  private nextPromptId = 0;
  private readonly promptCompletions = new Map<
    string,
    ReturnType<UiBackendClient["waitForPrompt"]>
  >();
  readonly handlers = new Set<UiEventHandler>();
  readonly archiveInputs: Parameters<UiBackendClient["archiveSession"]>[0][] =
    [];
  readonly abortedRunIds: string[] = [];
  readonly compactInputs: Parameters<UiBackendClient["compactSession"]>[0][] =
    [];
  readonly connectInputs: UiConnectModelInput[] = [];
  readonly executedCommands: UiSlashCommandInvocation[] = [];
  readonly probeInputs: UiProbeModelContextWindowInput[] = [];
  readonly searchInputs: UiSetSearchApiKeyInput[] = [];
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];
  private snapshot = emptySnapshot();

  constructor(input: { readonly snapshot?: UiSnapshot } = {}) {
    if (input.snapshot !== undefined) {
      this.snapshot = input.snapshot;
    }
  }

  getSnapshot(): Promise<UiSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  getContextWindowUsage(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null> {
    return Promise.resolve({
      contextWindowRatio: 0.01,
      contextWindowTokens: 100,
      currentTokens: 1,
      estimatedAt: timestamp,
      modelId: "fake-model",
      sessionId: input.sessionId,
    });
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  listCommands(): ReturnType<UiBackendClient["listCommands"]> {
    return Promise.resolve({
      commands: [
        {
          argumentMode: "structured",
          category: "setup",
          description: "Connect a model provider",
          id: "connect",
          path: ["connect"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "structured",
          category: "setup",
          description: "Connect a web search provider",
          id: "connect-search",
          path: ["connect-search"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Compact current session",
          id: "compact",
          path: ["compact"],
          source: "builtin",
          surfaces: ["tui"],
        },
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
          acceptsArguments: true,
          argumentMode: "raw",
          category: "skill",
          description: "Use Hansun knowledge base",
          id: "skill.hansun-db",
          path: ["hansun-db"],
          source: "skill",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    });
  }

  performPrompt(text: string, options?: SubmitPromptOptions): Promise<void> {
    this.submitted.push({ text, ...(options ? { options } : {}) });
    const sessionId = options?.sessionId ?? "session_1";
    const session = {
      createdAt: timestamp,
      id: sessionId,
      messages: [],
      title: "Session",
      updatedAt: timestamp,
    };
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: sessionId,
      sessions: [session],
    };
    this.emit({ session, type: "session.updated" });
    return Promise.resolve();
  }

  submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): ReturnType<UiBackendClient["submitPromptAccepted"]> {
    const promptId = `prompt_fake_${String(++this.nextPromptId)}`;
    const sessionId = options?.sessionId ?? "session_fake";
    const completion = this.performPrompt(text, options).then(() => ({
      prompt: {
        clientRequestId: options?.clientRequestId ?? `request_${promptId}`,
        createdAt: timestamp,
        endedAt: timestamp,
        promptId,
        scopeKey: "/workspace",
        sessionId,
        status: "succeeded" as const,
        text,
        updatedAt: timestamp,
        userMessageId: `message_${promptId}`,
      },
    }));
    this.promptCompletions.set(promptId, completion);
    return Promise.resolve({
      clientRequestId: options?.clientRequestId ?? `request_${promptId}`,
      createdAt: timestamp,
      promptId,
      sessionId,
      status: "queued",
      userMessageId: `message_${promptId}`,
    });
  }

  async submitPromptAndWait(
    text: string,
    options?: Parameters<UiBackendClient["submitPromptAndWait"]>[1],
  ): ReturnType<UiBackendClient["submitPromptAndWait"]> {
    const receipt = await this.submitPromptAccepted(text, options);
    return this.waitForPrompt(receipt.promptId);
  }

  waitForPrompt(
    promptId: string,
  ): ReturnType<UiBackendClient["waitForPrompt"]> {
    return (
      this.promptCompletions.get(promptId) ??
      Promise.reject(new Error(`Unknown prompt: ${promptId}`))
    );
  }

  editQueuedPrompt(): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return Promise.reject(new Error("No queued prompt in fake backend"));
  }

  cancelQueuedPrompt(): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return Promise.reject(new Error("No queued prompt in fake backend"));
  }

  acquirePromptEditLease(): ReturnType<
    UiBackendClient["acquirePromptEditLease"]
  > {
    return Promise.reject(new Error("No queued prompt in fake backend"));
  }

  renewPromptEditLease(): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return Promise.reject(new Error("No queued prompt in fake backend"));
  }

  releasePromptEditLease(): ReturnType<
    UiBackendClient["releasePromptEditLease"]
  > {
    return Promise.reject(new Error("No queued prompt in fake backend"));
  }

  editQueuedPromptForOwner(
    _input: Parameters<UiBackendClient["editQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return this.editQueuedPrompt();
  }

  cancelQueuedPromptForOwner(
    _input: Parameters<UiBackendClient["cancelQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return this.cancelQueuedPrompt();
  }

  acquirePromptEditLeaseForOwner(
    _input: Parameters<UiBackendClient["acquirePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
    return this.acquirePromptEditLease();
  }

  renewPromptEditLeaseForOwner(
    _input: Parameters<UiBackendClient["renewPromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return this.renewPromptEditLease();
  }

  releasePromptEditLeaseForOwner(
    _input: Parameters<UiBackendClient["releasePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
    return this.releasePromptEditLease();
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    this.compactInputs.push(options);
    return Promise.resolve(compactResult());
  }

  archiveSession(
    input: Parameters<UiBackendClient["archiveSession"]>[0],
  ): ReturnType<UiBackendClient["archiveSession"]> {
    this.archiveInputs.push(input);
    return Promise.resolve();
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    return Promise.resolve(null);
  }

  probeModelContextWindow(
    input: UiProbeModelContextWindowInput,
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    this.probeInputs.push(input);
    return Promise.resolve({
      contextWindowSource: "default",
      contextWindowTokens: 128_000,
    });
  }

  connectModel(
    input: UiConnectModelInput,
  ): ReturnType<UiBackendClient["connectModel"]> {
    this.connectInputs.push(input);
    return Promise.resolve(connectModelResult());
  }

  setSearchApiKey(
    input: UiSetSearchApiKeyInput,
  ): ReturnType<UiBackendClient["setSearchApiKey"]> {
    this.searchInputs.push(input);
    return Promise.resolve(setSearchApiKeyResult());
  }

  setPermission(
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): ReturnType<UiBackendClient["setPermission"]> {
    const permission: UiPermissionState = {
      ...(this.snapshot.permission ?? {
        level: "default",
        mode: "auto",
        sessionRules: [],
      }),
      ...input,
    };
    this.snapshot = { ...this.snapshot, permission };
    this.emit({ permission, type: "permission.updated" });
    return Promise.resolve(permission);
  }

  executeCommand(invocation: UiSlashCommandInvocation): Promise<void> {
    this.executedCommands.push(invocation);
    const commandRunId = `command_${String(this.executedCommands.length)}`;
    this.emit({
      command: {
        clientInvocationId: invocation.clientInvocationId,
        commandId: invocation.commandId,
        commandRunId,
        path: invocation.path,
        surface: invocation.surface,
        ...(invocation.sessionId === undefined
          ? {}
          : { sessionId: invocation.sessionId }),
      },
      timestamp: Date.parse(timestamp),
      type: "command.started",
    });
    const selectedSessionId = selectedSessionIdFromInvocation(invocation);
    if (selectedSessionId !== undefined) {
      const session = this.snapshot.sessions.find(
        (item) => item.id === selectedSessionId,
      ) ?? {
        createdAt: timestamp,
        id: selectedSessionId,
        messages: [],
        title: "New session",
        updatedAt: timestamp,
      };
      this.snapshot = {
        ...this.snapshot,
        activeSessionId: selectedSessionId,
        sessions: [
          ...this.snapshot.sessions.filter(
            (item) => item.id !== selectedSessionId,
          ),
          session,
        ],
      };
      this.emit({
        clientInvocationId: invocation.clientInvocationId,
        commandRunId,
        action: {
          data: { choiceId: selectedSessionId },
          kind: "session.selected",
        },
        output: {
          data: { sessionId: selectedSessionId },
          kind: "data",
          subject: "session.current",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      });
      return Promise.resolve();
    }
    this.emit({
      clientInvocationId: invocation.clientInvocationId,
      commandRunId,
      output: { kind: "text", text: "status ok" },
      timestamp: Date.parse(timestamp),
      type: "command.result.delivered",
    });
    return Promise.resolve();
  }

  respondPermission(): Promise<void> {
    return Promise.resolve();
  }

  respondInteraction(): Promise<void> {
    return Promise.resolve();
  }

  abortRun(runId: string): Promise<void> {
    this.abortedRunIds.push(runId);
    return Promise.resolve();
  }

  private emit(event: UiEvent): void {
    for (const handler of Array.from(this.handlers)) {
      handler(event);
    }
  }
}

function selectedSessionIdFromInvocation(
  invocation: UiSlashCommandInvocation,
): string | undefined {
  if (invocation.commandId === "new") {
    return "session_generated";
  }
  if (invocation.commandId !== "resume") {
    return undefined;
  }
  const sessionIdIndex = invocation.argv.indexOf("--session_id");
  const sessionId =
    sessionIdIndex < 0 ? undefined : invocation.argv[sessionIdIndex + 1];
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

describe("ohbaby-web with ohbaby-server /v1", () => {
  it("resolves abort targets at the web runtime boundary", async () => {
    const backend = new FakeBackend({
      snapshot: {
        ...emptySnapshot(),
        activeSessionId: "session_1",
        runs: [
          {
            id: "run_1",
            sessionId: "session_1",
            startedAt: timestamp,
            status: { kind: "running", runId: "run_1" },
            updatedAt: timestamp,
          },
          {
            id: "run_2",
            sessionId: "session_2",
            startedAt: timestamp,
            status: { kind: "running", runId: "run_2" },
            updatedAt: timestamp,
          },
        ],
        sessions: [
          {
            createdAt: timestamp,
            id: "session_1",
            messages: [],
            title: "Session 1",
            updatedAt: timestamp,
          },
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [],
            title: "Session 2",
            updatedAt: timestamp,
          },
        ],
        status: { kind: "running", runId: "run_1" },
      },
    });
    const server = createDaemonServerApp({
      authToken,
      backend,
      packageVersion: "0.1.7-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const runtime = createOhbabyWebRuntime(
        {
          baseUrl: "http://127.0.0.1:4096",
          clientId: "client_web",
          directory: "/repo",
          startupIntent: { resumeSessionId: "session_1" },
          token: authToken,
        },
        { fetch: fetchImpl },
      );
      await runtime.ready;

      await expect(
        runtime.abortSession("session_1", "run_1"),
      ).resolves.toBeUndefined();
      expect(backend.abortedRunIds).toEqual(["run_1"]);

      await expect(runtime.abortSession("session_2", "run_1")).rejects.toThrow(
        "does not belong to session",
      );
      expect(backend.abortedRunIds).toEqual(["run_1"]);

      await runtime.selectSession("session_2");
      await expect(
        runtime.abortSession("session_2", "run_2"),
      ).resolves.toBeUndefined();
      expect(backend.abortedRunIds).toEqual(["run_1", "run_2"]);

      await expect(
        runtime.abortSession("session_without_run"),
      ).resolves.toBeUndefined();
      await expect(
        runtime.abortSession("session_2", "run_unknown"),
      ).resolves.toBeUndefined();
      expect(backend.abortedRunIds).toEqual(["run_1", "run_2"]);
      await runtime.dispose();
    } finally {
      await server.dispose();
    }
  });

  it("connects through app.request and consumes prompt events", async () => {
    const backend = new FakeBackend();
    const server = createDaemonServerApp({
      authToken,
      backend,
      createSessionId: () => "session_generated",
      packageVersion: "0.1.7-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const config: OhbabyBootstrapConfig = {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: authToken,
      };
      const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
      await runtime.ready;
      const client = runtime.client;
      if (!client) throw new Error("Expected an active browser client");

      await client.submitPromptAccepted("hello", {
        clientRequestId: "request_1",
      });

      await waitFor(
        () =>
          runtime.store
            .getSnapshot()
            .view.snapshot?.sessions.some(
              (session) => session.id === "session_generated",
            ) === true,
        "timed out waiting for server event",
      );
      expect(backend.submitted).toEqual([
        {
          options: {
            clientRequestId: "request_1",
            sessionId: "session_generated",
          },
          text: "hello",
        },
      ]);
      expect(runtime.store.getSnapshot()).toMatchObject({
        connectionState: "live",
        view: {
          snapshot: {
            sessions: [{ id: "session_generated" }],
          },
        },
      });

      await runtime.executeSlashCommand({
        sessionId: "session_generated",
        text: "/status",
      });
      await waitFor(
        () =>
          runtime.store
            .getSnapshot()
            .view.commandNotices.some(
              (notice) =>
                notice.kind === "success" && notice.text === "status ok",
            ),
        "timed out waiting for command notice",
      );
      expect(backend.executedCommands).toHaveLength(1);
      expect(backend.executedCommands[0]).toMatchObject({
        commandId: "status",
        path: ["status"],
        raw: "/status",
        sessionId: "session_generated",
      });
      await runtime.dispose();
    } finally {
      await server.dispose();
    }
  });

  it("routes structured web commands through REST and keeps overlay ids out of raw command execution", async () => {
    const backend = new FakeBackend();
    const server = createDaemonServerApp({
      authToken,
      backend,
      createSessionId: () => "session_generated",
      packageVersion: "0.1.7-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const config: OhbabyBootstrapConfig = {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: authToken,
      };
      const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
      await runtime.ready;
      const client = runtime.client;
      if (!client) throw new Error("Expected an active browser client");

      const catalog = await runtime.listWebCommands();
      expect(
        catalog.commands.map((command) => [
          command.id,
          command.action,
          command.executionKind,
        ]),
      ).toEqual([
        ["connect", "connectModel", "overlay"],
        ["connect-search", "connectSearch", "overlay"],
        ["compact", "compactSession", "overlay"],
        ["status", "executeCommand", "passthrough"],
        ["skill.hansun-db", "executeCommand", "skill"],
      ]);

      await expect(
        runtime.executeSlashCommand({ text: "/connect" }),
      ).rejects.toThrow();
      const rawOverlayResponse = await fetchImpl(
        "http://127.0.0.1:4096/v1/commands",
        {
          body: JSON.stringify({
            argumentMode: "structured",
            argv: [],
            clientInvocationId: "manual",
            commandId: "connect",
            path: ["connect"],
            raw: "/connect",
            rawArgs: "",
            surface: "tui",
          }),
          headers: {
            authorization: `Bearer ${authToken}`,
            "content-type": "application/json",
            "x-ohbaby-client-id": "client_web",
          },
          method: "POST",
        },
      );
      expect(rawOverlayResponse.status).toBe(400);

      await runtime.executeSlashCommand({
        text: "/hansun-db 查 X",
      });
      expect(backend.executedCommands.at(-1)).toMatchObject({
        argumentMode: "raw",
        commandId: "skill.hansun-db",
        path: ["hansun-db"],
        raw: "/hansun-db 查 X",
        rawArgs: "查 X",
        surface: "tui",
      });

      await client.probeModelContextWindow({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      });
      await client.connectModel({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      });
      await client.setSearchApiKey({
        apiKeyEnv: "TAVILY_API_KEY",
        provider: "tavily",
      });
      await client.getContextWindowUsage({ sessionId: "session_1" });
      await client.compactSession({ force: true, sessionId: "session_1" });

      expect(backend.probeInputs[0]).toMatchObject({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      });
      expect(backend.connectInputs[0]).toMatchObject({
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
        provider: "zhipu",
      });
      expect(backend.searchInputs).toEqual([
        { apiKeyEnv: "TAVILY_API_KEY", provider: "tavily" },
      ]);
      expect(backend.compactInputs).toEqual([
        { force: true, sessionId: "session_1" },
      ]);
      expect(backend.executedCommands).toHaveLength(1);
      expect(
        backend.executedCommands.some(
          (command) => command.commandId === "connect",
        ),
      ).toBe(false);
      await runtime.dispose();
    } finally {
      await server.dispose();
    }
  });

  it("creates and selects sessions through dedicated REST routes", async () => {
    const backend = new FakeBackend();
    const server = createDaemonServerApp({
      authToken,
      backend,
      createSessionId: () => "session_generated",
      packageVersion: "0.1.7-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const config: OhbabyBootstrapConfig = {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: authToken,
      };
      const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
      await runtime.ready;

      await runtime.createSession();
      await runtime.createSession();
      await runtime.selectSession("session_2");

      expect(backend.executedCommands).toEqual([
        expect.objectContaining({
          argv: ["--no-reuse-empty-session"],
          commandId: "new",
          path: ["new"],
          raw: "/new --no-reuse-empty-session",
          rawArgs: "--no-reuse-empty-session",
        }),
        expect.objectContaining({
          argv: [],
          commandId: "new",
          path: ["new"],
          raw: "/new",
          rawArgs: "",
        }),
        expect.objectContaining({
          argv: ["--session_id", "session_2"],
          commandId: "resume",
          path: ["resume"],
          raw: "/resume --session_id session_2",
          rawArgs: "--session_id session_2",
        }),
      ]);
      await runtime.dispose();
    } finally {
      await server.dispose();
    }
  });

  it("reloads the selected session transcript after sidebar session selection", async () => {
    const backend = new FakeBackend({
      snapshot: {
        ...emptySnapshot(),
        activeSessionId: "session_1",
        sessions: [
          {
            createdAt: timestamp,
            id: "session_1",
            messages: [
              {
                createdAt: timestamp,
                id: "message_1",
                parts: [{ text: "old session", type: "text" }],
                role: "user",
              },
            ],
            title: "Old session",
            updatedAt: timestamp,
          },
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [
              {
                createdAt: timestamp,
                id: "message_2",
                parts: [{ text: "Reply with exactly: pong", type: "text" }],
                role: "user",
              },
              {
                completedAt: timestamp,
                createdAt: timestamp,
                id: "message_3",
                parts: [{ text: "pong", type: "text" }],
                role: "assistant",
                status: "completed",
              },
            ],
            title: "Reply with exactly: pong",
            updatedAt: timestamp,
          },
        ],
      },
    });
    const server = createDaemonServerApp({
      authToken,
      backend,
      createSessionId: () => "session_generated",
      packageVersion: "0.1.7-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const config: OhbabyBootstrapConfig = {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        directory: "/repo",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: authToken,
      };
      const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
      await runtime.ready;

      const initialProjectedSession = runtime.store
        .getSnapshot()
        .view.snapshot?.sessions.find((session) => session.id === "session_2");
      expect(initialProjectedSession?.messages).toEqual([]);

      await runtime.selectSession("session_2");
      await waitFor(
        () =>
          runtime.store
            .getSnapshot()
            .view.snapshot?.sessions.find(
              (session) => session.id === "session_2",
            )
            ?.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "pong",
              ),
            ) === true,
        "timed out waiting for selected session transcript",
      );
      expect(runtime.store.getSnapshot().view.snapshot).toMatchObject({
        activeSessionId: "session_2",
      });
      await runtime.dispose();
    } finally {
      await server.dispose();
    }
  });
});
