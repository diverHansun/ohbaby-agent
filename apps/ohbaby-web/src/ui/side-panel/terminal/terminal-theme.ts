import type { ITheme } from "@xterm/xterm";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

/**
 * The page's tokens, so the terminal matches the canvas (D6). The web has only
 * a light theme today; a dark theme only needs to redefine these tokens.
 */
export function terminalTheme(element: Element): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string): string | undefined =>
    style.getPropertyValue(`--${name}`).trim() || undefined;
  const theme: ITheme & Record<string, string | undefined> = {
    background: token("bg"),
    foreground: token("text"),
    cursor: token("accent"),
    cursorAccent: token("bg"),
    selectionBackground: token("term-selection"),
  };
  for (const color of ANSI) {
    const bright = `bright${color.charAt(0).toUpperCase()}${color.slice(1)}`;
    theme[color] = token(`term-${color}`);
    theme[bright] = token(`term-bright-${color}`);
  }
  return theme;
}

export function terminalFontFamily(element: Element): string {
  return getComputedStyle(element).getPropertyValue("--font-mono").trim();
}
