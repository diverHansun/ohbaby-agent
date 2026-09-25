import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createInMemorySessionManager } from "../../../packages/ohbaby-agent/src/services/session/index.js";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import { OhbabyTerminalApp } from "../../../packages/ohbaby-cli/src/tui/app.js";
import { createFakeLLMClient, waitForFrame } from "./helpers.js";
vi.mock("../../../packages/ohbaby-cli/src/tui/pending-prompts.js", () => ({
  createPendingPromptStorage: () => ({
    read: () => [],
    write: () => undefined,
  }),
}));

it("reads bounded in-process source history on PageUp and follows archive without a legacy snapshot", async () => {
  const bus = createBus();
  const messages = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  for (let index = 0; index < 52; index++) {
    const id = `history-${String(index).padStart(3, "0")}`;
    await messages.createMessage({
      id,
      sessionId: "history-root",
      role: "assistant",
      agent: "test",
    });
    await messages.appendPart(id, {
      type: "text",
      text: `stored-answer-${String(index).padStart(3, "0")}`,
    });
  }
  const sessionManager = createInMemorySessionManager({
    bus,
    messageCleaner: {
      removeMessages: (sessionId) => messages.removeMessages(sessionId),
    },
  });
  await sessionManager.ensureRoot({
    id: "history-root",
    agentName: "test",
    projectRoot: process.cwd(),
    title: "History",
  });
  const backend = createInProcessUiBackendClient({
    bus,
    sessionManager,
    messageManager: messages,
    llmClient: createFakeLLMClient([]),
    initialSnapshot: {
      activeSessionId: "history-root",
      permissions: [],
      runs: [],
      status: { kind: "idle" },
      sessions: [
        {
          id: "history-root",
          title: "History",
          createdAt: "2026-09-25",
          updatedAt: "2026-09-25",
          messages: [],
        },
      ],
    },
  });
  await backend.initialize();
  const legacy = vi.spyOn(backend, "getSnapshot");
  const history = vi.spyOn(backend, "getSessionHistory");
  const app = render(
    <OhbabyTerminalApp
      client={backend}
      subscribeEvents={backend.subscribeEvents}
    />,
  );
  try {
    const initial = await waitForFrame(app, (frame) =>
      frame.includes("stored-answer-051"),
    );
    expect(initial).not.toContain("stored-answer-000");
    expect(history).not.toHaveBeenCalled();
    app.stdin.write("\u001B[5~");
    const expanded = await waitForFrame(app, (frame) =>
      frame.includes("stored-answer-000"),
    );
    expect(expanded).toContain("stored-answer-051");
    expect(history).toHaveBeenCalledTimes(1);
    await backend.archiveSession({ sessionId: "history-root" });
    await waitForFrame(app, (frame) => !frame.includes("history-root"));
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    await backend.dispose();
  }
});
