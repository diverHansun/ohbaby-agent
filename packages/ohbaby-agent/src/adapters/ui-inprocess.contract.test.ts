import { describe, expect, it } from "vitest";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../services/providers/index.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import { createBus } from "../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../core/message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageStore,
} from "../core/message/index.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createFakeLLMClient(
  events: readonly ProviderStreamEvent[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        _request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createRejectingLLMClient(
  error: Error,
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.reject(error);
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createInitialSnapshotWithTwoSessions(): UiSnapshot {
  return {
    activeSessionId: "session_1",
    sessions: [
      {
        id: "session_1",
        title: "First",
        messages: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      {
        id: "session_2",
        title: "Second",
        messages: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    runs: [],
    permissions: [],
    status: { kind: "idle" },
  };
}

describe("createInProcessUiBackendClient", () => {
  it("submits a prompt and publishes streaming message updates", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([
        { textDelta: "Hello" },
        { textDelta: " world", finishReason: "stop" },
      ]),
    });
    const events: UiEvent[] = [];

    client.subscribeEvents((event) => {
      events.push(event);
    });

    await client.submitPrompt("Say hello");

    expect(events.map((event) => event.type)).toEqual([
      "session.updated",
      "message.appended",
      "runtime.updated",
      "run.updated",
      "message.appended",
      "message.updated",
      "message.part.delta",
      "message.updated",
      "message.part.delta",
      "run.updated",
      "runtime.updated",
    ]);

    const assistantUpdates = events.filter(
      (event): event is Extract<UiEvent, { type: "message.updated" }> =>
        event.type === "message.updated",
    );

    expect(assistantUpdates.map((event) => event.message.parts)).toEqual([
      [{ type: "text", text: "Hello" }],
      [{ type: "text", text: "Hello world" }],
    ]);
    const assistantDeltas = events.filter(
      (event): event is Extract<UiEvent, { type: "message.part.delta" }> =>
        event.type === "message.part.delta",
    );

    expect(
      assistantDeltas.map((event) => ({
        content: event.content,
        delta: event.delta,
      })),
    ).toEqual([
      { content: "Hello", delta: "Hello" },
      { content: "Hello world", delta: " world" },
    ]);

    const snapshot = await client.getSnapshot();
    expect(snapshot.status).toEqual({ kind: "idle" });
    expect(snapshot.sessions).toHaveLength(1);
    expect(
      snapshot.sessions[0].messages.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(snapshot.sessions[0].messages[1].parts).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("marks the run and app status as error when streaming fails", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createRejectingLLMClient(new Error("stream exploded")),
    });

    await expect(client.submitPrompt("Say hello")).rejects.toThrow(
      "stream exploded",
    );

    const snapshot = await client.getSnapshot();
    expect(snapshot.status).toEqual({
      kind: "error",
      message: "stream exploded",
      recoverable: true,
    });
    expect(snapshot.runs[0].status).toEqual({
      kind: "error",
      message: "stream exploded",
      recoverable: true,
    });
  });

  it("activates an existing session when submitting to it", async () => {
    const client = createInProcessUiBackendClient({
      initialSnapshot: createInitialSnapshotWithTwoSessions(),
      llmClient: createFakeLLMClient([
        { textDelta: "Done", finishReason: "stop" },
      ]),
    });

    await client.submitPrompt("Continue here", { sessionId: "session_2" });

    const snapshot = await client.getSnapshot();
    expect(snapshot.activeSessionId).toBe("session_2");
    expect(
      snapshot.sessions.find((session) => session.id === "session_2")?.messages,
    ).toHaveLength(2);
  });

  it("generates ids that do not collide with initial snapshot records", async () => {
    const client = createInProcessUiBackendClient({
      initialSnapshot: {
        activeSessionId: "session_2",
        sessions: [
          {
            id: "session_2",
            title: "Existing",
            messages: [
              {
                id: "message_2",
                role: "user",
                parts: [{ type: "text", text: "existing" }],
                createdAt: "2026-05-13T00:00:00.000Z",
              },
            ],
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
        runs: [
          {
            id: "run_2",
            sessionId: "session_2",
            status: { kind: "idle" },
            startedAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
        permissions: [],
        status: { kind: "idle" },
      },
      llmClient: createFakeLLMClient([
        { textDelta: "New", finishReason: "stop" },
      ]),
    });

    await client.submitPrompt("New session");

    const snapshot = await client.getSnapshot();
    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "session_2",
      "session_3",
    ]);
    expect(
      snapshot.sessions.flatMap((session) =>
        session.messages.map((message) => message.id),
      ),
    ).toEqual(["message_2", "message_3", "message_4"]);
    expect(snapshot.runs.map((run) => run.id)).toEqual(["run_2", "run_3"]);
  });

  it("reserves explicitly provided ids before generating new ones", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([
        { textDelta: "Custom", finishReason: "stop" },
        { textDelta: "Auto", finishReason: "stop" },
      ]),
    });

    await client.submitPrompt("Custom session", { sessionId: "session_1" });
    await client.submitPrompt("Automatic session");

    const snapshot = await client.getSnapshot();
    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "session_1",
      "session_2",
    ]);
  });

  it("persists prompt and assistant response through core message manager", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      store: createInMemoryMessageStore(),
      idGenerator: createDeterministicMessageIds(),
      now: () => 1_700_000_000_000,
    });
    const client = createInProcessUiBackendClient({
      messageManager,
      llmClient: createFakeLLMClient([
        { textDelta: "Core", finishReason: "stop" },
      ]),
    });

    await client.submitPrompt("Use core message");

    await expect(
      messageManager.listBySession("session_1"),
    ).resolves.toMatchObject([
      {
        info: { id: "message_1", role: "user" },
        parts: [{ id: "part_1", type: "text", text: "Use core message" }],
      },
      {
        info: {
          id: "message_2",
          role: "assistant",
          parentId: "message_1",
          finish: "stop",
        },
        parts: [{ id: "part_2", type: "text", text: "Core" }],
      },
    ]);
  });

  it("does not mutate the SDK snapshot when core message persistence fails before run start", async () => {
    const client = createInProcessUiBackendClient({
      messageManager: createRejectingMessageManager(
        new Error("core write failed"),
      ),
      llmClient: createFakeLLMClient([
        { textDelta: "Never reached", finishReason: "stop" },
      ]),
    });

    await expect(client.submitPrompt("Should not persist")).rejects.toThrow(
      "core write failed",
    );

    await expect(client.getSnapshot()).resolves.toEqual({
      activeSessionId: null,
      sessions: [],
      runs: [],
      permissions: [],
      status: { kind: "idle" },
    });
  });

  it("isolates UI event handler errors from prompt execution", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([
        { textDelta: "Still works", finishReason: "stop" },
      ]),
    });
    client.subscribeEvents(() => {
      throw new Error("handler failed");
    });

    await client.submitPrompt("Ignore handler failures");

    const snapshot = await client.getSnapshot();
    expect(snapshot.status).toEqual({ kind: "idle" });
    expect(snapshot.sessions[0].messages[1].parts).toEqual([
      { type: "text", text: "Still works" },
    ]);
  });

  it("rejects concurrent prompt submission in v1", async () => {
    let releaseStream: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const baseClient = createFakeLLMClient([]);
    const client = createInProcessUiBackendClient({
      llmClient: {
        ...baseClient,
        provider: {
          ...baseClient.provider,
          streamChatCompletion(): Promise<AsyncIterable<ProviderStreamEvent>> {
            return Promise.resolve(
              (async function* (): AsyncGenerator<
                ProviderStreamEvent,
                void,
                unknown
              > {
                await release;
                yield { textDelta: "Done", finishReason: "stop" };
              })(),
            );
          },
        },
      },
    });

    const first = client.submitPrompt("First");

    await expect(client.submitPrompt("Second")).rejects.toThrow(
      "A prompt is already running",
    );

    releaseStream?.();
    await first;
  });

  it("lists command catalog entries for the requested surface", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });

    const catalog = await client.listCommands({ surface: "tui" });

    expect(catalog.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "status",
        "tools",
        "abort",
        "exit",
        "model",
        "model.list",
        "model.current",
        "session",
        "session.list",
      ]),
    );
  });

  it("executes commands and publishes SDK command events", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });

    await client.executeCommand({
      argv: [],
      clientInvocationId: "inv_status",
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      command: {
        clientInvocationId: "inv_status",
        commandId: "status",
      },
      type: "command.started",
    });
    expect(events[1]).toMatchObject({
      clientInvocationId: "inv_status",
      output: { kind: "data", subject: "status", data: { status: "idle" } },
      type: "command.result.delivered",
    });
  });

  it("round-trips command interactions through respondInteraction", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });

    const execution = client.executeCommand({
      argv: [],
      clientInvocationId: "inv_model",
      commandId: "model",
      path: ["model"],
      raw: "/model",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "command.started" });
    expect(events[1]).toMatchObject({
      request: {
        clientInvocationId: "inv_model",
        interactionId: "interaction_1",
        kind: "select-one",
        subject: "model",
      },
      type: "interaction.requested",
    });

    await client.respondInteraction("interaction_1", {
      choiceId: "fake:fake-model",
      kind: "accepted",
    });
    await execution;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interactionId: "interaction_1",
          status: "accepted",
          type: "interaction.resolved",
        }),
        expect.objectContaining({
          action: {
            data: { choiceId: "fake:fake-model" },
            kind: "model.selected",
          },
          type: "command.result.delivered",
        }),
      ]),
    );
  });

  it("aborts pending command interactions by command run id", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });

    const execution = client.executeCommand({
      argv: [],
      clientInvocationId: "inv_model",
      commandId: "model",
      path: ["model"],
      raw: "/model",
      rawArgs: "",
      sessionId: "session_1",
      surface: "tui",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    await client.abortRun("command_1");
    await execution;

    expect(events.at(-1)).toMatchObject({
      clientInvocationId: "inv_model",
      commandRunId: "command_1",
      error: {
        code: "INTERACTION_CANCELLED",
      },
      type: "command.failed",
    });
  });
});

function createDeterministicMessageIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}

function createRejectingMessageManager(error: Error): MessageManager {
  const store: MessageStore = {
    ...createInMemoryMessageStore(),
    insertMessage(): Promise<void> {
      return Promise.reject(error);
    },
  };

  return createMessageManager({
    bus: createBus(),
    store,
    idGenerator: createDeterministicMessageIds(),
  });
}
