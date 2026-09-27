// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SteerButton } from "./SteerButton.js";
import type { UiPromptSubmission } from "ohbaby-sdk";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const prompt: UiPromptSubmission = {
  promptId: "p",
  clientRequestId: "c",
  scopeKey: "s",
  sessionId: "root",
  userMessageId: "m",
  text: "queued",
  status: "queued",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
describe("Steer button", () => {
  it("retains the original idempotency key after failure and disables lease-held rows", async () => {
    const element = document.createElement("div");
    const root = createRoot(element);
    const accepted = vi.fn();
    const steer = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({});
    const render = (runId = "run", lease = false): void => {
      act(() => {
        root.render(
          <SteerButton
            prompt={{
              ...prompt,
              editLeaseOwnerId: lease ? "other" : undefined,
            }}
            runId={runId}
            disabled={false}
            steer={steer}
            onAccepted={accepted}
          />,
        );
      });
    };
    render();
    await act(async () => {
      element.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(element.textContent).toContain("response lost");
    render("new-run");
    expect(element.querySelector("button")?.disabled).toBe(true);
    render("run", true);
    expect(element.querySelector("button")?.disabled).toBe(true);
    render();
    await act(async () => {
      element.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(steer.mock.calls[1][0]).toEqual(steer.mock.calls[0][0]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(element.textContent).toContain("Accepted");
    act(() => {
      root.unmount();
    });
  });
});
