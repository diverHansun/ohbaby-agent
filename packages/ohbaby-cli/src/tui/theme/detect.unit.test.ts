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
});
