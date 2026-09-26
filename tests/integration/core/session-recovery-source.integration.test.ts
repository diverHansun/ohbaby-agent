import { describe, expect, it, vi } from "vitest";
import { applySessionChange, type UiSessionChangedEvent } from "ohbaby-sdk";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("session recovery through real lifecycle", () => {
  it("captures a streaming cut, then merges later real message changes without duplicates", async () => {
    const emitted = deferred();
    const resume = deferred();
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const llmClient: LLMClientInstance = {
      config: {
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        maxTokens: 128,
        model: "fake-model",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        async streamResponse() {
          return (async function* () {
            yield { reasoningTextDelta: "thinking" };
            yield { textDelta: "first " };
            emitted.resolve();
            await resume.promise;
            yield { textDelta: "second", finishReason: "stop" as const };
          })();
        },
      },
    };
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: messages,
      llmClient,
      workdir: process.cwd(),
    });
    const events: UiSessionChangedEvent[] = [];
    const unsubscribe = backend.subscribeEvents((event) => {
      if (event.type === "session.changed") events.push(event);
    });
    try {
      const session = await backend.createSession();
      const receipt = await backend.submitPromptAccepted("hello", {
        sessionId: session.id,
        clientRequestId: "test-recovery",
      });
      await emitted.promise;
      // The provider yield is upstream of message persistence and the UI
      // projection. Capture the cut only once that projection contains the
      // first chunk, while the provider is still blocked on resume.
      const baseline = await vi.waitFor(async () => {
        const view = await backend.getSessionView!({ sessionId: session.id });
        expect(
          view.session.messages.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "first ",
            ),
          ),
        ).toBe(true);
        return view;
      });
      expect(baseline.version.runtimeEpoch).toBe(
        (await backend.getPermissionSnapshot({ rootSessionId: session.id }))
          .permissionEpoch,
      );
      resume.resolve();
      await backend.waitForPrompt(receipt.promptId);
      let merged = baseline;
      for (const event of events.filter(
        (event) =>
          event.version.sessionId === session.id &&
          event.version.sessionRevision > baseline.version.sessionRevision,
      ))
        merged = applySessionChange(merged, event)!;
      const stored = await messages.listBySession(session.id);
      const assistant = stored.find(
        (message) => message.info.role === "assistant",
      )!;
      expect(
        merged.session.messages.filter(
          (message) => message.id === assistant.info.id,
        ),
      ).toHaveLength(1);
      expect(
        merged.session.messages
          .find((message) => message.id === assistant.info.id)
          ?.parts.filter((part) => part.type === "text"),
      ).toEqual([expect.objectContaining({ text: "first second" })]);
      expect(
        baseline.session.messages
          .find((message) => message.id === assistant.info.id)
          ?.parts.find((part) => part.type === "text")?.text,
      ).toBe("first ");
      const control = await backend.getSessionControl!({
        sessionId: session.id,
      });
      expect(control.runId).toBeNull();
      const recoveredReceipt = await backend.getPromptReceipt!({
        clientRequestId: "test-recovery",
      });
      expect(recoveredReceipt.receipt?.promptId).toBe(receipt.promptId);
    } finally {
      resume.resolve();
      unsubscribe();
      await backend.dispose();
    }
  });
});

it("isolates pending display reasoning between independent runtimes even with colliding session and message IDs", async () => {
  function runtime(label: string) {
    const emitted = deferred();
    const finish = deferred();
    const save = deferred();
    const bus = createBus();
    let messageId = 0,
      partId = 0;
    const manager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
      idGenerator: {
        messageId: () => `same-message-${String(++messageId)}`,
        partId: () => `same-part-${String(++partId)}`,
      },
    });
    const persist = manager.saveReasoningPart.bind(manager);
    vi.spyOn(manager, "saveReasoningPart").mockImplementation(async (input) => {
      await save.promise;
      return persist(input);
    });
    const llmClient: LLMClientInstance = {
      config: {
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        maxTokens: 128,
        model: "fake",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        streamResponse: () =>
          Promise.resolve(
            (async function* () {
              yield { reasoningTextDelta: `${label} private thought` };
              yield { textDelta: `${label} body` };
              emitted.resolve();
              await finish.promise;
              yield { finishReason: "stop" as const };
            })(),
          ),
      },
    };
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: manager,
      llmClient,
      workdir: process.cwd(),
      initialSnapshot: {
        activeSessionId: "same-session",
        sessions: [
          {
            id: "same-session",
            title: "Existing conversation",
            createdAt: "2026",
            updatedAt: "2026",
            messages: [],
          },
        ],
        permissions: [],
        runs: [],
        status: { kind: "idle" },
      },
    });
    return { backend, manager, emitted, finish, save };
  }
  const a = runtime("A"),
    b = runtime("B");
  const scope = { sessionId: "same-session" };
  try {
    const [receiptA, receiptB] = await Promise.all([
      a.backend.submitPromptAccepted("continue A", {
        ...scope,
        clientRequestId: "request-A",
      }),
      b.backend.submitPromptAccepted("continue B", {
        ...scope,
        clientRequestId: "request-B",
      }),
    ]);
    await Promise.all([a.emitted.promise, b.emitted.promise]);
    const [viewA, viewB] = await Promise.all([
      a.backend.getSessionView(scope),
      b.backend.getSessionView(scope),
    ]);
    const assistantA = viewA.session.messages.find(
      (message) => message.role === "assistant",
    );
    const assistantB = viewB.session.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantA?.id).toBe(assistantB?.id);
    const thoughtA = assistantA?.parts.find(
        (part) => part.type === "reasoning",
      ),
      thoughtB = assistantB?.parts.find((part) => part.type === "reasoning");
    expect(thoughtA?.id).toEqual(expect.any(String));
    expect(thoughtB?.id).toEqual(expect.any(String));
    expect(thoughtA?.id).not.toBe(thoughtB?.id);
    expect(thoughtA).toMatchObject({
      text: "A private thought",
      saveState: "pending",
    });
    expect(thoughtB).toMatchObject({
      text: "B private thought",
      saveState: "pending",
    });
    expect(viewA.version.runtimeEpoch).not.toBe(viewB.version.runtimeEpoch);
    expect(JSON.stringify(viewA)).not.toContain("B private thought");
    expect(JSON.stringify(viewB)).not.toContain("A private thought");
    a.finish.resolve();
    await a.backend.waitForPrompt(receiptA.promptId);
    a.save.resolve();
    await vi.waitFor(async () => {
      expect(
        (await a.backend.getSessionView(scope)).session.messages.flatMap(
          (message) => message.parts,
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          text: "A private thought",
          saveState: "saved",
        }),
      );
    });
    const stillB = await b.backend.getSessionView(scope);
    expect(
      stillB.session.messages.flatMap((message) => message.parts),
    ).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        text: "B private thought",
        saveState: "pending",
      }),
    );
    expect((await b.backend.getSessionControl(scope)).runId).not.toBeNull();
    expect(
      (await b.manager.listBySession(scope.sessionId))
        .flatMap((message) => message.parts)
        .some((part) => part.type === "reasoning"),
    ).toBe(false);
    b.finish.resolve();
    await b.backend.waitForPrompt(receiptB.promptId);
    b.save.resolve();
    await vi.waitFor(async () => {
      expect(
        (await b.backend.getSessionView(scope)).session.messages.flatMap(
          (message) => message.parts,
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          text: "B private thought",
          saveState: "saved",
        }),
      );
    });
  } finally {
    a.finish.resolve();
    b.finish.resolve();
    a.save.resolve();
    b.save.resolve();
    await Promise.all([a.backend.dispose(), b.backend.dispose()]);
  }
});
