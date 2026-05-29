import { describe, expect, it } from "vitest";
import * as SystemPromptApi from "../index.js";

describe("system-prompt public API", () => {
  it("does not expose the internal agent prompt wrapper", () => {
    expect("generateAgentPrompt" in SystemPromptApi).toBe(false);
  });
});
