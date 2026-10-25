import { describe, expect, it } from "vitest";
import { paletteFit } from "./SlashPalette.js";

describe("paletteFit", () => {
  it("keeps the preferred side and caps the height to the room there", () => {
    expect(paletteFit("up", { top: 600, bottom: 700 }, 800)).toEqual({
      placement: "up",
      maxHeight: 534,
    });
    expect(paletteFit("down", { top: 100, bottom: 200 }, 800)).toEqual({
      placement: "down",
      maxHeight: 578,
    });
  });

  it("flips a cramped side when the other side has more room", () => {
    // The hero card sits low on a short window: 178px below, 314px above.
    expect(paletteFit("down", { top: 380, bottom: 500 }, 700)).toEqual({
      placement: "up",
      maxHeight: 314,
    });
  });

  it("stays put when the other side is no better", () => {
    expect(paletteFit("down", { top: 120, bottom: 500 }, 700)).toEqual({
      placement: "down",
      maxHeight: 178,
    });
  });
});
