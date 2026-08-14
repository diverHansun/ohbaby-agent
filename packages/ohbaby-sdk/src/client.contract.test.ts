import { describe, expect, it } from "vitest";
import type {
  UiAcquirePromptEditLeaseInput,
  UiCommandClient,
  UiPromptCommandClient,
  UiPromptQueueCommandClient,
  UiQueryClient,
} from "./index.js";

type HasKey<T, Key extends PropertyKey> = Key extends keyof T ? true : false;

describe("UI client capability contract", () => {
  it("keeps prompt submission, waiting, and queue editing in distinct capabilities", () => {
    const boundaries: readonly [
      HasKey<UiQueryClient, "waitForPrompt">,
      HasKey<UiQueryClient, "submitPromptAccepted">,
      HasKey<UiPromptCommandClient, "submitPromptAccepted">,
      HasKey<UiPromptCommandClient, "submitPromptAndWait">,
      HasKey<UiPromptCommandClient, "waitForPrompt">,
      HasKey<UiPromptCommandClient, "editQueuedPrompt">,
      HasKey<UiPromptQueueCommandClient, "editQueuedPrompt">,
      HasKey<UiCommandClient, "editQueuedPrompt">,
    ] = [true, false, true, true, false, false, true, true];

    expect(boundaries).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it("does not let public queue inputs self-assert a lease owner", () => {
    const input: UiAcquirePromptEditLeaseInput = { promptId: "prompt_1" };

    expect(input).toEqual({ promptId: "prompt_1" });
    expect("ownerClientId" in input).toBe(false);
  });
});
