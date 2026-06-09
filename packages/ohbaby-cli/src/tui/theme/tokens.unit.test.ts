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
      palette: [darkPalette.gold],
    });
    expect(theme.workingSpinner).toEqual({
      base: darkPalette.purple,
      highlight: darkPalette.purpleShimmer,
    });
    expect(theme.tool.name).toBe(darkPalette.gold);
    expect(theme.tool.name).not.toBe(darkPalette.goldBright);
    expect(theme.tool.arg).toBe(darkPalette.textDim);
    expect(theme.reasoning).toBe(darkPalette.textMuted);
    expect(theme.border).toBe(darkPalette.border);
    expect(theme.message.userBlockBg).toBe(darkPalette.userBlockBg);
    expect(theme.message.userGutter).toBe(darkPalette.textMuted);
    expect(theme.message.userBlockBg).not.toBe(theme.border);
    expect(theme.message.userBlockBg).not.toBe(darkPalette.surface);
    expect(theme.spinner.palette).not.toContain(theme.message.userBlockBg);
  });

  it("maps light semantic tokens to the light palette", () => {
    const theme = createTheme("light", 3);

    expect(theme.brandTitle.primary).toBe(lightPalette.gold);
    expect(theme.workingSpinner).toEqual({
      base: lightPalette.purple,
      highlight: lightPalette.purpleShimmer,
    });
    expect(theme.text.normal).toBe(lightPalette.text);
    expect(theme.border).toBe(lightPalette.border);
    expect(theme.message.userBlockBg).toBe(lightPalette.userBlockBg);
    expect(theme.message.userGutter).toBe(lightPalette.textMuted);
    expect(theme.message.userBlockBg).not.toBe(lightPalette.surface);
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
    expect(theme.message.userBlockBg).toBe("blue");
    expect(theme.message.userGutter).toBe("gray");
    expect(theme.tool.name).toBe("yellow");
    expect(theme.tool.arg).toBe("gray");
    expect(theme.spinner.palette).toEqual(["yellow"]);
    expect(theme.workingSpinner).toEqual({
      base: "magenta",
      highlight: "whiteBright",
    });
  });
});
