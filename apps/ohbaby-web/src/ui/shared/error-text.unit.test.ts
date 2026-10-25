import { describe, expect, it, vi } from "vitest";
import { readableError } from "./error-text.js";

describe("readableError", () => {
  it("words network failures from each browser the same way", () => {
    for (const raw of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ]) {
      expect(readableError(raw)).toBe(
        "Can't reach ohbaby. Check that it's still running.",
      );
    }
  });

  it("hides protocol wording but keeps it in the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readableError("Daemon event is missing a valid sequence id")).toBe(
      "Lost sync with ohbaby. Reload the page if this doesn't clear.",
    );
    expect(warn).toHaveBeenCalledWith(
      "[ohbaby] Daemon event is missing a valid sequence id",
    );
    warn.mockRestore();
  });

  it("passes other messages through", () => {
    expect(readableError("Session not found")).toBe("Session not found");
  });
});
