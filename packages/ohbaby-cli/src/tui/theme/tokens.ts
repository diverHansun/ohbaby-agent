import { darkPalette, lightPalette, type RawPalette } from "./colors.js";

export type ColorMode = "dark" | "light";
export type ColorLevel = 0 | 1 | 2 | 3;

export interface Theme {
  readonly border: string;
  readonly brandTitle: {
    readonly primary: string;
    readonly secondary: string;
    readonly tertiary: string;
  };
  readonly cursor: string;
  readonly diff: {
    readonly add: string;
    readonly remove: string;
  };
  readonly message: {
    readonly userBlockBg: string;
    readonly userGutter: string;
  };
  readonly mode: ColorMode;
  readonly reasoning: string;
  readonly role: {
    readonly assistant: string;
    readonly user: string;
  };
  readonly spinner: {
    readonly frames: readonly string[];
    readonly palette: readonly string[];
  };
  readonly status: {
    readonly accent: string;
    readonly error: string;
    readonly idle: string;
    readonly running: string;
    readonly success: string;
    readonly waiting: string;
    readonly warning: string;
  };
  readonly text: {
    readonly dim: string;
    readonly heading: string;
    readonly headingAccent: string;
    readonly link: string;
    readonly muted: string;
    readonly normal: string;
    readonly strong: string;
  };
  readonly tool: {
    readonly arg: string;
    readonly failed: string;
    readonly name: string;
    readonly running: string;
    readonly success: string;
  };
}

export const BRAILLE_SPINNER_FRAMES = [
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

export function createTheme(mode: ColorMode, colorLevel = 3): Theme {
  const palette = mode === "light" ? lightPalette : darkPalette;
  const color = createColorResolver(palette, colorLevel);

  return {
    border: color("border", "gray"),
    brandTitle: {
      primary: color("gold", "yellow"),
      secondary: color("purple", "magenta"),
      tertiary: color("skyBlue", "cyan"),
    },
    cursor: color("goldBright", "yellow"),
    diff: {
      add: color("green", "green"),
      remove: color("red", "red"),
    },
    message: {
      userBlockBg: color("userBlockBg", "blue"),
      userGutter: color("textMuted", "gray"),
    },
    mode,
    reasoning: color("textMuted", "gray"),
    role: {
      assistant: color("text", "white"),
      user: color("text", "white"),
    },
    spinner: {
      frames: BRAILLE_SPINNER_FRAMES,
      palette: [color("goldBright", "yellow"), color("purple", "magenta")],
    },
    status: {
      accent: color("skyBlue", "cyan"),
      error: color("red", "red"),
      idle: color("textDim", "gray"),
      running: color("gold", "yellow"),
      success: color("green", "green"),
      waiting: color("yellow", "yellow"),
      warning: color("yellow", "yellow"),
    },
    text: {
      dim: color("textDim", "gray"),
      heading: color("gold", "yellow"),
      headingAccent: color("skyBlue", "cyan"),
      link: color("skyBlue", "cyan"),
      muted: color("textMuted", "gray"),
      normal: color("text", "white"),
      strong: color("textStrong", "white"),
    },
    tool: {
      arg: color("textDim", "gray"),
      failed: color("red", "red"),
      name: color("skyBlue", "cyan"),
      running: color("purple", "magenta"),
      success: color("green", "green"),
    },
  };
}

function createColorResolver(
  palette: RawPalette,
  colorLevel: number,
): (key: keyof RawPalette, ansiName: string) => string {
  const useTrueColor = colorLevel >= 2;
  return (key, ansiName) => (useTrueColor ? palette[key] : ansiName);
}
