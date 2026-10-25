import { describe, expect, it } from "vitest";
import { greetingFor } from "./DraftHero.js";

describe("greetingFor", () => {
  it("follows the time of day at each boundary", () => {
    expect(greetingFor(4)).toBe("Working late?");
    expect(greetingFor(5)).toBe("Good morning");
    expect(greetingFor(11)).toBe("Good morning");
    expect(greetingFor(12)).toBe("Good afternoon");
    expect(greetingFor(18)).toBe("Good evening");
    expect(greetingFor(22)).toBe("Good evening");
    expect(greetingFor(23)).toBe("Working late?");
    expect(greetingFor(0)).toBe("Working late?");
  });
});
