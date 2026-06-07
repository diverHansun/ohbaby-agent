import { describe, expect, it } from "vitest";
import { darkPalette, lightPalette } from "./colors.js";
import { createTheme } from "./tokens.js";

const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

describe("createTheme", () => {
  it("maps dark semantic tokens to the agreed raw palette", () => {
    const theme = createTheme("dark", 3);

    expect(theme.brandTitle).toEqual({
      primary: darkPalette.gold,
      secondary: darkPalette.purple,
      tertiary: darkPalette.skyBlue,
    });
    expect(theme.spinner).toEqual({
      frames: BRAILLE_SPINNER_FRAMES,
      palette: [darkPalette.goldBright, darkPalette.purple],
    });
    expect(theme.tool.name).toBe(darkPalette.skyBlue);
    expect(theme.reasoning).toBe(darkPalette.textMuted);
    expect(theme.border).toBe(darkPalette.border);
  });

  it("maps light semantic tokens to the light palette", () => {
    const theme = createTheme("light", 3);

    expect(theme.brandTitle.primary).toBe(lightPalette.gold);
    expect(theme.text.normal).toBe(lightPalette.text);
    expect(theme.border).toBe(lightPalette.border);
  });

  it("downgrades truecolor tokens to stable ansi names for low-color terminals", () => {
    const theme = createTheme("dark", 0);

    expect(theme.brandTitle).toEqual({
      primary: "yellow",
      secondary: "magenta",
      tertiary: "cyan",
    });
    expect(theme.status.error).toBe("red");
    expect(theme.border).toBe("gray");
  });
});
