import { describe, expect, it } from "vitest";
import { createSessionIdGenerator } from "./id-generator.js";

describe("createSessionIdGenerator", () => {
  it("generates timestamped session ids", () => {
    const generator = createSessionIdGenerator({
      now: () => 1_700_000_000_000,
      random: () => 0.5,
    });

    expect(generator()).toMatch(/^session_1700000000000_[a-z0-9]+$/);
    expect(generator()).not.toEqual(generator());
  });
});
