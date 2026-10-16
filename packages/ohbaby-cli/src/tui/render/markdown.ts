import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk, { type ForegroundColorName } from "chalk";
import type { Theme } from "../theme/tokens.js";
import { sanitizeTerminalText, wrapAnsi } from "./wrap.js";

export interface MarkdownRenderOptions {
  readonly width: number;
  readonly theme?: Theme;
}

function markdownTheme(theme?: Theme): MarkdownTheme {
  const color =
    (value: string | undefined) =>
    (text: string): string => {
      if (!value) return text;
      return value.startsWith("#")
        ? chalk.hex(value)(text)
        : chalk[value as ForegroundColorName](text);
    };
  return {
    heading: (text) => chalk.bold(color(theme?.text.heading)(text)),
    link: color(theme?.text.link),
    linkUrl: color(theme?.text.dim),
    code: (text) => color(theme?.text.strong)(`\`${text}\``),
    codeBlock: (text) => text,
    codeBlockBorder: color(theme?.text.muted),
    quote: color(theme?.text.normal),
    quoteBorder: color(theme?.text.muted),
    hr: color(theme?.text.muted),
    listBullet: color(theme?.text.muted),
    bold: chalk.bold,
    italic: chalk.italic,
    strikethrough: chalk.strikethrough,
    underline: chalk.underline,
    codeBlockIndent: "  ",
  };
}

export function mdToAnsi(
  markdown: string,
  options: MarkdownRenderOptions,
): string[] {
  const width = Math.max(1, Math.floor(options.width));
  const source = sanitizeTerminalText(markdown);
  try {
    // Only invoke the public text component. Ink owns terminal IO and input.
    const rendered = new Markdown(
      source,
      0,
      0,
      markdownTheme(options.theme),
      undefined,
      { preserveOrderedListMarkers: true, renderLatex: false },
    ).render(width);
    // Pi detects terminal hyperlink support and retains visible URLs otherwise.
    // Only generated web links survive the display boundary; raw input above
    // cannot inject OSC controls. Wrapping closes links on each physical row.
    return rendered.flatMap((line) =>
      wrapAnsi(line.trimEnd(), width, { hyperlinks: true }),
    );
  } catch {
    return wrapAnsi(source, width);
  }
}
