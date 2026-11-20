import { describe, expect, it, vi } from "vitest";
import { readableError, sessionOpenError } from "./error-text.js";

describe("readableError", () => {
  it("words network failures from each browser the same way", () => {
    for (const raw of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ]) {
      expect(readableError(raw)).toBe(
        "Can't reach your services. Check that they're still running.",
      );
    }
  });

  it("hides protocol wording but keeps it in the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readableError("Daemon event is missing a valid sequence id")).toBe(
      "Lost sync with your services. Reload the page if this doesn't clear.",
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

describe("sessionOpenError", () => {
  it("points to Move to workspace when the chat's folder is gone", () => {
    for (const code of ["directory-unavailable", "directory-not-directory"]) {
      const error = Object.assign(new Error("raw server wording"), {
        status: 400,
        code,
      });
      expect(sessionOpenError(error)).toBe(
        "This chat's folder is missing or unreadable. Use Move to workspace in the chat menu to choose an available folder.",
      );
    }
  });

  it("keeps other failures as they are", () => {
    const error = Object.assign(new Error("Session not found"), {
      status: 404,
      code: "SESSION_NOT_FOUND",
    });
    expect(sessionOpenError(error)).toBe("Session not found");
  });
});
