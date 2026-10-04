import { describe, expect, it } from "vitest";
import { detectTheme } from "./detect.js";

describe("detectTheme", () => {
  it("defaults to dark mode when no explicit signal exists", () => {
    expect(detectTheme({ chalkLevel: 3, env: {} }).mode).toBe("dark");
  });

  it("honors an explicit light theme environment setting", () => {
    expect(
      detectTheme({
        chalkLevel: 3,
        env: { OHBABY_TUI_THEME: "light" },
      }).mode,
    ).toBe("light");
  });

  it("forces low-color tokens when color is disabled", () => {
    const detected = detectTheme({
      chalkLevel: 3,
      env: { NO_COLOR: "1" },
    });

    expect(detected.colorLevel).toBe(0);
    expect(detected.theme.brandTitle.primary).toBe("yellow");
  });

  it("derives mode and a subtle user surface from the real terminal background", () => {
    const dark = detectTheme({
      chalkLevel: 3,
      env: {},
      terminalColors: {
        background: { r: 0x1e, g: 0x1e, b: 0x2e },
        foreground: { r: 0xcd, g: 0xd6, b: 0xf4 },
      },
    });
    expect(dark.mode).toBe("dark");
    expect(dark.theme.message.userBlockBg).toBe("#303042");

    const light = detectTheme({
      chalkLevel: 3,
      env: {},
      terminalColors: { background: { r: 255, g: 255, b: 255 } },
    });
    expect(light.mode).toBe("light");
    expect(light.theme.message.userBlockBg).toBe("#EDEDED");
  });

  it("uses no message fill when the background is unknown and unconfigured", () => {
    expect(
      detectTheme({ chalkLevel: 3, env: {}, terminalColors: {} }).theme.message
        .userBlockBg,
    ).toBeUndefined();
    expect(
      detectTheme({
        chalkLevel: 3,
        env: { COLORFGBG: "0;15" },
        terminalColors: {},
      }).mode,
    ).toBe("light");
  });
});
