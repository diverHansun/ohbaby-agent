import { highlightCode } from "./highlight.js";
import { wrapAnsi } from "./wrap.js";

const FENCE_PATTERN = /^```(\S*)\s*$/u;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;
const UNORDERED_PATTERN = /^\s*[-*+]\s+(.+)$/u;
const ORDERED_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/u;
const QUOTE_PATTERN = /^\s*>\s?(.+)$/u;

export interface MarkdownRenderOptions {
  readonly width: number;
}

export function mdToAnsi(
  markdown: string,
  options: MarkdownRenderOptions,
): string[] {
  const lines: string[] = [];
  const sourceLines = markdown.replace(/\r\n/gu, "\n").split("\n");
  let inFence = false;
  let fenceLanguage = "";

  for (const rawLine of sourceLines) {
    const fence = FENCE_PATTERN.exec(rawLine);
    if (fence) {
      if (inFence) {
        lines.push("```");
        inFence = false;
        fenceLanguage = "";
      } else {
        inFence = true;
        fenceLanguage = fence[1];
        lines.push(fenceLanguage === "" ? "```" : `\`\`\`${fenceLanguage}`);
      }
      continue;
    }

    if (inFence) {
      for (const highlighted of highlightCode(rawLine)) {
        lines.push(
          ...wrapAnsi(highlighted, Math.max(1, options.width - 2)).map(
            (line) => `  ${line}`,
          ),
        );
      }
      continue;
    }

    if (rawLine.trim() === "") {
      lines.push("");
      continue;
    }

    const heading = HEADING_PATTERN.exec(rawLine);
    if (heading) {
      const text = normalizeInlineMarkdown(heading[2]);
      lines.push(...wrapAnsi(text, options.width));
      if (heading[1].length === 1) {
        lines.push("-".repeat(Math.min(text.length, options.width)));
      }
      continue;
    }

    const unordered = UNORDERED_PATTERN.exec(rawLine);
    if (unordered) {
      lines.push(
        ...wrapAnsi(
          `- ${normalizeInlineMarkdown(unordered[1])}`,
          options.width,
        ),
      );
      continue;
    }

    const ordered = ORDERED_PATTERN.exec(rawLine);
    if (ordered) {
      lines.push(
        ...wrapAnsi(
          `${ordered[1]}. ${normalizeInlineMarkdown(ordered[2])}`,
          options.width,
        ),
      );
      continue;
    }

    const quote = QUOTE_PATTERN.exec(rawLine);
    if (quote) {
      lines.push(
        ...wrapAnsi(`> ${normalizeInlineMarkdown(quote[1])}`, options.width),
      );
      continue;
    }

    lines.push(...wrapAnsi(normalizeInlineMarkdown(rawLine), options.width));
  }

  return lines;
}

function normalizeInlineMarkdown(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 ($2)")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/_([^_]+)_/gu, "$1");
}
