import { describe, expect, it, vi } from "vitest";
import { submitPromptAndWait } from "./client.js";
import type {
  SubmitPromptOptions,
  UiCompletedPromptSubmission,
  UiPromptCompletion,
  UiPromptError,
  UiPromptReceipt,
  UiSubmitPromptAndWaitOptions,
  UiWaitForPromptOptions,
} from "./index.js";

const runtimeError: UiPromptError = {
  code: "RUNTIME_ERROR",
  message: "provider stopped",
  retryable: false,
  source: "runtime",
};

function completedPrompt(
  status: UiCompletedPromptSubmission["status"],
): UiCompletedPromptSubmission {
  const base = {
    clientRequestId: "request_1",
    createdAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:02.000Z",
    promptId: "prompt_1",
    scopeKey: "/workspace",
    sessionId: "session_1",
    text: "hello",
    updatedAt: "2026-08-14T00:00:02.000Z",
    userMessageId: "message_1",
  } as const;

  switch (status) {
    case "succeeded":
    case "cancelled":
      return { ...base, status };
    case "failed":
    case "interrupted":
      return { ...base, error: runtimeError, status };
  }
}

describe("prompt completion contract", () => {
  it.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
    "represents %s as a completed prompt",
    (status) => {
      const prompt = completedPrompt(status);

      expect(prompt.status).toBe(status);
      expect(prompt.endedAt).toBe("2026-08-14T00:00:02.000Z");
      expect("answer" in prompt).toBe(false);
      expect("messages" in prompt).toBe(false);
    },
  );

  it("composes accepted and wait without turning a failed outcome into a rejection", async () => {
    const receipt: UiPromptReceipt = {
      clientRequestId: "request_1",
      createdAt: "2026-08-14T00:00:00.000Z",
      promptId: "prompt_1",
      sessionId: "session_1",
      status: "queued",
      userMessageId: "message_1",
    };
    const completion: UiPromptCompletion = {
      prompt: completedPrompt("failed"),
    };
    const signal = new AbortController().signal;
    const submitPromptAccepted = vi.fn(
      (_text: string, _options?: SubmitPromptOptions) =>
        Promise.resolve(receipt),
    );
    const waitForPrompt = vi.fn(
      (_promptId: string, _options?: UiWaitForPromptOptions) =>
        Promise.resolve(completion),
    );
    const options: UiSubmitPromptAndWaitOptions = {
      clientRequestId: "request_1",
      sessionId: "session_1",
      signal,
    };

    await expect(
      submitPromptAndWait(
        { submitPromptAccepted, waitForPrompt },
        "hello",
        options,
      ),
    ).resolves.toBe(completion);
    expect(submitPromptAccepted).toHaveBeenCalledOnce();
    expect(submitPromptAccepted).toHaveBeenCalledWith("hello", {
      clientRequestId: "request_1",
      sessionId: "session_1",
    });
    expect(waitForPrompt).toHaveBeenCalledOnce();
    expect(waitForPrompt).toHaveBeenCalledWith("prompt_1", { signal });
  });
});
