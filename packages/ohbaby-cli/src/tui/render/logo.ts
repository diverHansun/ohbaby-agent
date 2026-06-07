import figlet from "figlet";
import ansiShadowFont from "figlet/importable-fonts/ANSI Shadow.js";

const LOGO_TEXT = "OHBABY";
const LOGO_FONT = "OHBABY ANSI Shadow";
const COMPACT_LOGO_WIDTH = LOGO_TEXT.length;

let registered = false;
let cachedLogo: readonly string[] | undefined;

export interface LogoRenderOptions {
  readonly maxWidth?: number;
}

export function renderOhbabyLogo(
  options: LogoRenderOptions = {},
): readonly string[] {
  const maxWidth = normalizeWidth(options.maxWidth);
  const logo = getGeneratedLogo();
  const logoWidth = measureWidth(logo);

  if (maxWidth < logoWidth && maxWidth < 64) {
    return [LOGO_TEXT.slice(0, maxWidth || COMPACT_LOGO_WIDTH)];
  }

  return logo;
}

function getGeneratedLogo(): readonly string[] {
  if (cachedLogo) {
    return cachedLogo;
  }

  ensureFontRegistered();
  cachedLogo = figlet
    .textSync(LOGO_TEXT, {
      font: LOGO_FONT,
      horizontalLayout: "fitted",
      verticalLayout: "fitted",
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return cachedLogo;
}

function ensureFontRegistered(): void {
  if (registered) {
    return;
  }

  figlet.parseFont(LOGO_FONT, ansiShadowFont);
  registered = true;
}

function normalizeWidth(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.max(0, Math.floor(width));
}

function measureWidth(lines: readonly string[]): number {
  return Math.max(0, ...lines.map((line) => line.length));
}
