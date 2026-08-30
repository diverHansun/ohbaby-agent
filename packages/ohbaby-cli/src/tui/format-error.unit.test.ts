import { describe, expect, it } from "vitest";
import { formatError } from "./format-error.js";

describe("TUI error formatting", () => {
  it("preserves stable error codes without loading the agent runtime", () => {
    expect(formatError({ code: "SESSION_NOT_FOUND", message: "Missing" })).toBe(
      "[SESSION_NOT_FOUND] Missing",
    );
    expect(formatError({ code: "private code", message: "Failed" })).toBe(
      "Failed",
    );
    expect(formatError(new Error("Native problem"))).toBe("Native problem");
    expect(formatError("plain")).toBe("plain");
  });
});
