import { describe, expect, it } from "vitest";
import { interactivePanelKindForCommandId } from "./command-panel-state.js";

describe("command panel state", () => {
  it("maps /connect-search to an interactive panel", () => {
    expect(interactivePanelKindForCommandId("connect-search")).toBe(
      "connect-search",
    );
  });
});
