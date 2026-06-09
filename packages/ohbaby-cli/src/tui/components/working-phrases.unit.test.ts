import { describe, expect, it } from "vitest";
import { WORKING_PHRASES, pickWorkingPhrase } from "./working-phrases.js";

describe("working-phrases", () => {
  it("exposes a non-empty list of non-empty phrases", () => {
    expect(WORKING_PHRASES.length).toBeGreaterThan(0);
    for (const phrase of WORKING_PHRASES) {
      expect(typeof phrase).toBe("string");
      expect(phrase.trim().length).toBeGreaterThan(0);
    }
  });

  it("always picks a member of the phrase list", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(WORKING_PHRASES).toContain(pickWorkingPhrase());
    }
  });
});
