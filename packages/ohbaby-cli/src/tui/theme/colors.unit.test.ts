import { describe, expect, it } from "vitest";
import { darkPalette, lightPalette } from "./colors.js";

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

describe("theme color palettes", () => {
  it("defines matching dark and light palette keys", () => {
    expect(Object.keys(lightPalette).sort()).toEqual(
      Object.keys(darkPalette).sort(),
    );
  });

  it("keeps every raw palette value as a six-digit hex color", () => {
    for (const palette of [darkPalette, lightPalette]) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(HEX_COLOR);
      }
    }
  });

  it("keeps the agreed dark brand colors from tui-improve-1", () => {
    expect(darkPalette.gold).toBe("#D4A24F");
    expect(darkPalette.purple).toBe("#B9A3E3");
    expect(darkPalette.skyBlue).toBe("#6E9FCE");
  });
});
