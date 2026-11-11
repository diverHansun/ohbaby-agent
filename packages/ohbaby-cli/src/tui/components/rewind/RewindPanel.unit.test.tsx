import { render } from "ink-testing-library";
import type { UiPromptSubmission } from "ohbaby-sdk";
import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RewindPanel } from "./RewindPanel.js";

const flag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = flag.IS_REACT_ACT_ENVIRONMENT;
beforeEach(() => {
  flag.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  flag.IS_REACT_ACT_ENVIRONMENT = previous;
});

function prompt(promptId: string): UiPromptSubmission {
  return {
    promptId,
    clientRequestId: `client-${promptId}`,
    scopeKey: "scope",
    sessionId: "session",
    userMessageId: `user-${promptId}`,
    text: promptId,
    status: "succeeded",
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
}

async function press(
  app: ReturnType<typeof render>,
  input: string,
): Promise<void> {
  await act(async () => {
    app.stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("RewindPanel", () => {
  const onConfirm = vi.fn((target: UiPromptSubmission) => {
    void target;
    return Promise.resolve(null);
  });
  const panel = (
    prompts: readonly UiPromptSubmission[],
    active = true,
  ): ReactElement => (
    <RewindPanel
      prompts={prompts}
      active={active}
      confirmation={(turns) => `Rewind ${String(turns)}`}
      onConfirm={onConfirm}
      onClose={() => undefined}
    />
  );
  beforeEach(() => {
    onConfirm.mockClear();
  });

  it("keeps the chosen prompt when a newer row appears before confirming", async () => {
    const app = render(panel([prompt("second"), prompt("first")]));
    await press(app, "\r");
    expect(app.lastFrame()).toContain("Rewind 1");
    // A queued prompt starts running: it lands on top of the list.
    await act(async () => {
      app.rerender(panel([prompt("third"), prompt("second"), prompt("first")]));
      await Promise.resolve();
    });
    expect(app.lastFrame()).toContain("Rewind 2");
    await press(app, "\r");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ promptId: "second" });
    app.unmount();
  });

  it("ignores keys while another dialog owns the keyboard", async () => {
    const app = render(panel([prompt("only")], false));
    await press(app, "\r");
    await press(app, "\r");
    expect(app.lastFrame()).not.toContain("Rewind 1");
    expect(onConfirm).not.toHaveBeenCalled();
    app.unmount();
  });
});
