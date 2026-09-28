// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import { ConversationStream } from "./ConversationStream.js";
import { ConversationPresentation } from "./ConversationPresentation.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function message(
  id: string,
  role: UiMessage["role"],
  runtimeInputKind?: "subagent-status" | "subagent-result" | "user-steer",
): UiMessage {
  return {
    id,
    role,
    runtimeInputKind,
    createdAt: "2026-09-28T00:00:00Z",
    parts: [{ type: "text", text: id }],
  };
}

describe("shared conversation visibility", () => {
  it.each([false, true])(
    "hides internal inputs on history and live updates (child=%s)",
    (child) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const ordinary = [
        message("parent prompt", "user"),
        message("normal notice", "system"),
        message("Runtime subagent result quoted by assistant", "assistant"),
        message("user steer", "user", "user-steer"),
      ];
      const render = (messages: readonly UiMessage[]): void => {
        act(() => {
          root.render(
            <ConversationPresentation.Provider value={{ fromParent: child }}>
              <ConversationStream
                historyState="ready"
                historyHasMore={false}
                historyStale={false}
                onLoadHistory={() => Promise.resolve()}
                promptRows={[]}
                messages={messages}
                sessionId="session"
                prompts={[]}
                activeRun={undefined}
                isRunning={false}
                reasoningByMessageId={{}}
                commandNotices={null}
                preserveMessageOrder={child}
              />
            </ConversationPresentation.Provider>,
          );
        });
      };
      try {
        render([
          ...ordinary,
          message("internal result", "system", "subagent-result"),
        ]);
        expect(
          container.querySelector('[data-message-id="internal result"]'),
        ).toBeNull();
        render([
          ...ordinary,
          message("internal result", "system", "subagent-result"),
          message("internal observation", "system", "subagent-status"),
          message("normal progress", "assistant"),
        ]);
        expect(container.textContent).not.toContain("internal result");
        expect(container.textContent).not.toContain("internal observation");
        for (const item of ordinary)
          expect(container.textContent).toContain(item.id);
        expect(container.textContent).toContain("normal progress");
        expect(container.querySelectorAll("[data-message-id]")).toHaveLength(5);
        if (child) expect(container.textContent).toContain("From parent");
      } finally {
        act(() => {
          root.unmount();
        });
        container.remove();
      }
    },
  );
});
