// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageEditor, type EditedPrompt } from "./UserMessageEditor.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function render(
  onSend: (input: EditedPrompt) => Promise<string | null>,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    createRoot(container).render(
      <UserMessageEditor
        initialSkill="code-review"
        initialText="看看"
        hints={[]}
        onSend={onSend}
        onCancel={() => undefined}
      />,
    );
  });
  return container;
}

async function key(textarea: HTMLTextAreaElement, name: string): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: name }),
    );
    await Promise.resolve();
  });
}

describe("UserMessageEditor with a skill token", () => {
  it("sends the token and request apart, and drops a skill error once the token goes", async () => {
    const onSend = vi.fn(() =>
      Promise.resolve<string | null>("Skill /code-review is no longer available."),
    );
    const container = render(onSend);
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("textarea not found");

    await key(textarea, "Enter");
    expect(onSend).toHaveBeenCalledWith({ skill: "code-review", text: "看看" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "no longer available",
    );

    textarea.setSelectionRange(0, 0);
    await key(textarea, "Backspace");
    expect(container.querySelector(".ohb-skill-token")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(textarea.value).toBe("看看");
  });
});
