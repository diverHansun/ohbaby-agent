import chalk from "chalk";
import {
  luminance,
  mixRgb,
  rgbToHex,
  type RgbColor,
  type TerminalColors,
} from "./terminal-colors.js";
import {
  createTheme,
  type ColorLevel,
  type ColorMode,
  type Theme,
} from "./tokens.js";

export interface DetectThemeInput {
  readonly chalkLevel?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Colors reported by the terminal; defaults to the startup probe result. */
  readonly terminalColors?: TerminalColors;
}

let probedTerminalColors: TerminalColors = {};

/** Record the startup OSC 10/11 probe so every theme detection can use it. */
export function setTerminalColors(colors: TerminalColors): void {
  probedTerminalColors = colors;
}

export interface ThemeDetection {
  readonly colorLevel: ColorLevel;
  readonly mode: ColorMode;
  readonly theme: Theme;
}

export function detectTheme(input: DetectThemeInput = {}): ThemeDetection {
  const env = input.env ?? process.env;
  const terminal = input.terminalColors ?? probedTerminalColors;
  const explicit = explicitMode(env);
  const background = terminal.background;
  const mode =
    explicit ??
    (background
      ? luminance(background) > 0.4
        ? "light"
        : "dark"
      : (colorFgBgMode(env) ?? "dark"));
  const colorLevel = detectColorLevel(env, input.chalkLevel ?? chalk.level);

  return {
    colorLevel,
    mode,
    theme: createTheme(mode, colorLevel, {
      userBlockBg: background
        ? userBlockFromBackground(background, terminal.foreground, mode)
        : // Without a known background a fixed fill can be a black bar on a
          // light terminal (or the reverse); keep only the gutter unless the
          // user or terminal told us which kind of background this is.
          explicit !== undefined || colorFgBgMode(env) !== undefined
          ? undefined
          : null,
    }),
  };
}

/**
 * A low-contrast tint of the terminal's own background (like OpenCode's and
 * Gemini CLI's message surfaces): a few percent toward the foreground, so it
 * reads as a subtle panel on any dark or light scheme.
 */
function userBlockFromBackground(
  background: RgbColor,
  foreground: RgbColor | undefined,
  mode: ColorMode,
): string {
  const toward =
    foreground ??
    (mode === "dark" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 });
  return rgbToHex(mixRgb(background, toward, mode === "dark" ? 0.1 : 0.07));
}

function explicitMode(
  env: Readonly<Record<string, string | undefined>>,
): ColorMode | undefined {
  const explicit = env.OHBABY_TUI_THEME?.trim().toLowerCase();
  return explicit === "light" || explicit === "dark" ? explicit : undefined;
}

/** rxvt-style COLORFGBG="fg;bg" (also set by iTerm2 and Konsole). */
function colorFgBgMode(
  env: Readonly<Record<string, string | undefined>>,
): ColorMode | undefined {
  const background = env.COLORFGBG?.split(";").at(-1);
  if (background === undefined || !/^\d+$/u.test(background)) return undefined;
  const index = Number(background);
  return index === 7 || index === 15 ? "light" : "dark";
}

function detectColorLevel(
  env: Readonly<Record<string, string | undefined>>,
  chalkLevel: number,
): ColorLevel {
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0") {
    return 0;
  }

  const forced = parseForcedColor(env.FORCE_COLOR);
  if (forced !== undefined) {
    return forced;
  }

  return normalizeColorLevel(chalkLevel);
}

function parseForcedColor(value: string | undefined): ColorLevel | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return 1;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? undefined : normalizeColorLevel(parsed);
}

function normalizeColorLevel(value: number): ColorLevel {
  if (value <= 0) {
    return 0;
  }
  if (value === 1) {
    return 1;
  }
  if (value === 2) {
    return 2;
  }
  return 3;
}
