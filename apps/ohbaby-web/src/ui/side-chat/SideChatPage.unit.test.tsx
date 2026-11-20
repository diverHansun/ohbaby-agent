// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UiBackendClient, UiMessage, UiSessionView } from "ohbaby-sdk";
import {
  createSideChatDraft,
  type SideChatConnection,
} from "../../runtime/side-chat.js";
import { createOhbabyWebStore } from "../../store/store.js";
import { SideChatPage } from "./SideChatPage.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const message = (id: string): UiMessage => ({
  id,
  role: "assistant",
  createdAt: "2026-11-20T00:00:00Z",
  parts: [{ type: "text", text: id }],
});
function view(messages: readonly UiMessage[]): UiSessionView {
  return {
    version: {
      runtimeEpoch: "e",
      sessionId: "side",
      viewGeneration: "g",
      sessionRevision: 1,
    },
    session: {
      id: "side",
      title: "side",
      createdAt: "0",
      updatedAt: "0",
      messages,
    },
    runs: [],
    prompts: [],
    history: { before: "cursor", hasMore: true },
    reasoningMissing: false,
    todo: { status: "ready", value: null },
    goal: { status: "ready", value: null },
    context: { status: "ready", value: null },
  };
}

it.each([
  ["before the boundary", [message("own")], 1],
  ["at the boundary", [message("boundary"), message("own")], 0],
] as const)(
  "stops side chat paging at its boundary, stale pages included: %s (T15)",
  async (_, messages, expectedLoads) => {
    const store = createOhbabyWebStore();
    store.setSessionSync({
      status: "ready",
      scope: { sessionId: "side", runtimeEpoch: "e" },
      view: view(messages),
      attempts: 1,
    });
    // A loaded page went stale: the stale flag alone must not cross the boundary.
    store.installSessionHistory({
      version: view(messages).version,
      messages: [],
      runs: [],
      prompts: [],
      before: "cursor",
      hasMore: true,
      reasoningMissing: false,
    });
    store.invalidateSessionHistory({
      type: "session.changed",
      version: { ...view(messages).version, sessionRevision: 2 },
      historyInvalidated: true,
    });
    expect(store.getSnapshot().historyStale).toBe(true);
    const loadEarlierHistory = vi.fn(() => Promise.resolve(false));
    const connection: SideChatConnection = {
      sideChatId: "side",
      store,
      client: {} as UiBackendClient,
      draft: createSideChatDraft(),
      abortSession: () => Promise.resolve(),
      retryPermissions: () => undefined,
      retrySession: () => undefined,
      loadEarlierHistory,
      close: () => Promise.resolve(),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SideChatPage
          connection={connection}
          entry={{
            sideChatId: "side",
            title: "Side",
            boundaryMessageId: "boundary",
            workingDirectory: "/repo",
          }}
        />,
      );
      await Promise.resolve();
    });
    // jsdom has no layout, so a sticky stream is "shorter than a screen".
    expect(loadEarlierHistory).toHaveBeenCalledTimes(expectedLoads);
    expect(container.querySelector(".ohb-history-slot") !== null).toBe(
      expectedLoads > 0,
    );
    act(() => {
      root.unmount();
    });
  },
);
