import chalk from "chalk";
import {
  createTheme,
  type ColorLevel,
  type ColorMode,
  type Theme,
} from "./tokens.js";

export interface DetectThemeInput {
  readonly chalkLevel?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ThemeDetection {
  readonly colorLevel: ColorLevel;
  readonly mode: ColorMode;
  readonly theme: Theme;
}

export function detectTheme(input: DetectThemeInput = {}): ThemeDetection {
  const env = input.env ?? process.env;
  const mode = detectMode(env);
  const colorLevel = detectColorLevel(env, input.chalkLevel ?? chalk.level);

  return {
    colorLevel,
    mode,
    theme: createTheme(mode, colorLevel),
  };
}

function detectMode(
  env: Readonly<Record<string, string | undefined>>,
): ColorMode {
  const explicit = env.OHBABY_TUI_THEME?.trim().toLowerCase();
  return explicit === "light" ? "light" : "dark";
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
