import { expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import {
  createSessionSync,
  type SessionSyncState,
  type UiEvent,
} from "ohbaby-sdk";
import { createDaemonHttpServer } from "../runtime/daemon/server.js";
import { createRemoteUiBackendClient } from "../protocols/jsonrpc/client.js";

it("keeps two SDK clients synchronized through healthy entry and subsequent revisions", async () => {
  const recover = vi.fn(() => Promise.resolve(false));
  const backend = createInProcessUiBackendClient({
    recoverExecutionSession: recover,
    initialSnapshot: {
      activeSessionId: "a",
      sessions: ["a", "b"].map((id) => ({
        id,
        title: id,
        messages: [],
        createdAt: "2026-09-29",
        updatedAt: "2026-09-29",
      })),
      runs: [],
      permissions: [],
      status: { kind: "idle" },
    },
    llmClient: {
      config: {
        apiKeyEnv: "TEST_ONLY",
        baseUrl: "https://invalid.test",
        interfaceProvider: "openai-compatible",
        maxTokens: 100,
        model: "fake",
        provider: "fake",
        temperature: 0,
      },
      provider: {
        id: "fake",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse: () =>
          Promise.resolve(
            (async function* (): AsyncGenerator<
              { textDelta: string; finishReason: "stop" },
              void,
              unknown
            > {
              yield await Promise.resolve({
                textDelta: "finished",
                finishReason: "stop" as const,
              });
            })(),
          ),
      },
    },
  });
  const server = createDaemonHttpServer({
    backend,
    authToken: "entry-test",
    host: "127.0.0.1",
    port: 0,
  });
  const clients: ReturnType<typeof connect>[] = [];
  function connect(id: string): {
    client: ReturnType<typeof createRemoteUiBackendClient>;
    sync: ReturnType<typeof createSessionSync>;
    reads: string[];
    states: SessionSyncState[];
    events: UiEvent[];
  } {
    const client = createRemoteUiBackendClient({
      port: server.port,
      authToken: "entry-test",
      clientId: id,
      startupIntent: { resumeSessionId: "a" },
    });
    const reads: string[] = [];
    const states: SessionSyncState[] = [];
    const events: UiEvent[] = [];
    const sync = createSessionSync({
      query: (scope, signal) => {
        reads.push(`${scope.sessionId}:${String(scope.bindingGeneration)}`);
        return client.getSessionView({ ...scope, signal });
      },
      onChange: (state) => states.push(state),
    });
    client.subscribeEvents((event) => {
      events.push(event);
      if (event.type === "session.resync-required") {
        if (event.disconnected) sync.disconnect();
        else
          sync.begin(
            event.sessionId
              ? {
                  sessionId: event.sessionId,
                  runtimeEpoch: event.runtimeEpoch,
                  bindingGeneration: event.bindingGeneration,
                }
              : null,
            event.connectionGeneration ?? 0,
          );
      } else if (
        event.type === "session.changed" ||
        event.type === "session.unavailable"
      )
        sync.receive(event);
    });
    const result = { client, sync, reads, states, events };
    clients.push(result);
    return result;
  }
  try {
    await server.start();
    const first = connect("first");
    await vi.waitFor(() => {
      expect(first.sync.getState().status).toBe("ready");
    });
    const version = first.sync.getState().view?.version;
    const second = connect("second");
    await vi.waitFor(() => {
      expect(second.sync.getState().status).toBe("ready");
    });
    expect(first.sync.getState().view?.version).toEqual(version);
    expect(second.sync.getState().view?.version).toEqual(version);
    expect(first.reads).toHaveLength(1);
    expect(second.reads).toHaveLength(1);
    await first.client.selectSession("b");
    await vi.waitFor(() => {
      expect(first.sync.getState()).toMatchObject({
        status: "ready",
        scope: { sessionId: "b" },
      });
    });
    await first.client.selectSession("a");
    await vi.waitFor(() => {
      expect(first.sync.getState()).toMatchObject({
        status: "ready",
        scope: { sessionId: "a" },
      });
    });
    await first.client.selectSession("a");
    await vi.waitFor(() => {
      expect(first.sync.getState().status).toBe("ready");
    });
    expect(first.sync.getState().view?.version).toEqual(version);
    expect(second.reads).toHaveLength(1);
    const checks = recover.mock.calls.length;
    const receipt = await backend.submitPromptAccepted("one fake turn", {
      sessionId: "a",
    });
    await backend.waitForPrompt(receipt.promptId);
    await vi.waitFor(() => {
      for (const { sync } of clients)
        expect(
          sync
            .getState()
            .view?.prompts.some((prompt) => prompt.status === "succeeded"),
        ).toBe(true);
    });
    expect(recover.mock.calls.length).toBeGreaterThan(checks);
    for (const { reads, states, events, sync } of clients) {
      expect(new Set(reads).size).toBe(reads.length);
      expect(states.every((state) => !state.error && state.attempts <= 1)).toBe(
        true,
      );
      expect(
        events.filter((event) => event.type === "session.unavailable"),
      ).toEqual([]);
      expect(
        events.filter(
          (event) =>
            event.type === "session.changed" &&
            event.executionRecovery !== undefined,
        ),
      ).toEqual([]);
      expect(sync.getState().view?.version.viewGeneration).toBe(
        version?.viewGeneration,
      );
      expect(sync.getState().view?.version.sessionRevision).toBeGreaterThan(
        version?.sessionRevision ?? 0,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ scenario: "healthy-two-client-entry", clients: clients.map(({ reads, states }) => ({ reads, states: states.map(({ status, attempts, view, scope }) => ({ status, attempts, session: scope?.sessionId, revision: view?.version.sessionRevision, generation: view?.version.viewGeneration })) })) })}\n`,
    );
  } finally {
    for (const { client, sync } of clients) {
      sync.dispose();
      await client.dispose();
    }
    await server.stop();
    await backend.dispose();
  }
});
