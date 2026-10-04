import {
  Markdown,
  setCapabilityOverrides,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import chalk, { type ForegroundColorName } from "chalk";
import type { Theme } from "../theme/tokens.js";
import { sanitizeTerminalText, wrapAnsi } from "./wrap.js";

// This app consumes Pi only as a text renderer. Keep URLs visible for native
// terminal copying instead of emitting terminal-dependent OSC link controls.
setCapabilityOverrides({ hyperlinks: false });

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
    linkUrl: color(theme?.text.muted),
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
    // Pi may emit terminal-dependent OSC links and pads its component lines.
    // Keep only safe styles at our display boundary and enforce narrow widths.
    return rendered.flatMap((line) => wrapAnsi(line.trimEnd(), width));
  } catch {
    return wrapAnsi(source, width);
  }
}
