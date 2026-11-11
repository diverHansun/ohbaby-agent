import { describe, expect, it } from "vitest";
import { sessionActionErrorText } from "./session-action-errors.js";

const coded = (code: string): Error =>
  Object.assign(new Error("server text"), { code });

describe("sessionActionErrorText", () => {
  it("uses the design texts for known codes", () => {
    expect(sessionActionErrorText("fork", coded("FORK_TARGET_INVALID"))).toBe(
      "Nothing to fork yet",
    );
    expect(
      sessionActionErrorText("edit", coded("REWIND_BEFORE_COMPACTION")),
    ).toBe("This message was compacted and can't be edited");
    expect(sessionActionErrorText("rewind", coded("SESSION_ARCHIVED"))).toBe(
      "Archived sessions can't be edited",
    );
  });

  it("falls back to the server's message for other codes", () => {
    expect(sessionActionErrorText("fork", coded("SESSION_RUNNING"))).toBe(
      "Something went wrong: server text",
    );
    expect(sessionActionErrorText("edit", "boom")).toBe(
      "Something went wrong: boom",
    );
  });
});
