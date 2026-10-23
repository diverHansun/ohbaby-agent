import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entry = new URL("./styles.css", import.meta.url);
const files = importedFiles(entry);
const css = files.map((file) => readFileSync(file, "utf8")).join("\n");

// Follow the bootstrap entry's imports in order so assertions inspect the same
// rule sequence as the bundled stylesheet.
function importedFiles(url: URL): URL[] {
  const text = readFileSync(url, "utf8");
  const imports = [...text.matchAll(/^@import "([^"]+)";$/gmu)].map(
    (match) => new URL(match[1], url),
  );
  return imports.length === 0 ? [url] : imports.flatMap(importedFiles);
}

function fileName(url: URL): string {
  return url.pathname.split("/ui/")[1] ?? url.pathname;
}

describe("web stylesheet structure", () => {
  it("loads tokens first, then the reset, then shared blocks and features", () => {
    const order = files.map(fileName);
    expect(order.slice(0, 3)).toEqual([
      "styles/tokens.css",
      "styles/base.css",
      "shared/shared.css",
    ]);
    expect(order).not.toContain("styles/overrides.css");
    expect(
      order.every(
        (name) => !name.startsWith("styles/") || order.indexOf(name) < 2,
      ),
    ).toBe(true);
  });

  it("keeps literal colors in tokens.css only", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/iu;
    for (const file of files) {
      if (fileName(file) === "styles/tokens.css") continue;
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
      expect(literal.exec(text)?.[0], fileName(file)).toBeUndefined();
    }
  });

  it("uses the brand colors only for the wordmark", () => {
    const users = files
      .filter((file) => fileName(file) !== "styles/tokens.css")
      .filter((file) => readFileSync(file, "utf8").includes("--brand-"))
      .map(fileName);
    expect(users).toEqual(["shared/shared.css"]);
  });

  it("falls back to solid surfaces without backdrop-filter", () => {
    expect(css).toMatch(
      /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)\s*\{\s*:root\s*\{[^}]*--bg-glass: var\(--bg-glass-solid\)/u,
    );
  });

  it("stops motion under reduced motion except for spinners", () => {
    expect(css).toContain(
      "*:not(.ohb-spinner):not(.ohb-send-spinner):not(.ohb-stop-pending)",
    );
  });
});

describe("web layout styles", () => {
  it("keeps the shell to the viewport while only the transcript scrolls", () => {
    expectCssRule(".ohb-shell", ["height: 100dvh", "overflow: hidden"]);
    expectCssRule(".ohb-main-body", ["min-height: 0", "position: relative"]);
    expectCssRule(".ohb-stream", ["min-height: 0", "overflow-y: auto"]);
    expectCssRule(".ohb-composer", ["bottom: 0", "position: absolute"]);
    expectCssRule(".ohb-composer-hero", ["position: relative"]);
  });

  it("turns the sidebar into a drawer with a scrim on narrow windows", () => {
    const narrow =
      /@media \(max-width: 1023px\)\s*\{(?<body>[\s\S]*?)\n\}/u.exec(css)
        ?.groups?.body ?? "";
    expect(narrow).toMatch(/\.ohb-shell-sidebar\s*\{[^}]*position: absolute/u);
    expect(narrow).toMatch(
      /\.ohb-shell\.is-sidebar-open \.ohb-shell-scrim\s*\{[^}]*display: block/u,
    );
  });

  it("keeps sidebar rows single-line and reveals row actions on hover", () => {
    expectCssRule(".ohb-session-title", [
      "overflow: hidden",
      "white-space: nowrap",
    ]);
    expectCssRule(".ohb-session-actions", ["opacity: 0", "position: absolute"]);
  });

  it("keeps composer send and stop circular inside the card", () => {
    expectCssRule(".ohb-send-button,\n.ohb-stop-button", [
      "border-radius: 50%",
      "height: 30px",
      "padding: 0",
      "width: 30px",
    ]);
    expectCssRule(".ohb-composer-input", [
      "flex-direction: column",
      "max-width: var(--content-width)",
    ]);
    expectCssRule(".ohb-composer-bar", ["display: flex"]);
  });

  it("supports a bounded, contained composer textarea scroll", () => {
    expectCssRule(".ohb-composer textarea", [
      "line-height: 22px",
      "max-height: 154px",
      "overflow-y: auto",
      "overscroll-behavior: contain",
    ]);
  });

  it("keeps slash command rows aligned without category dots", () => {
    expectCssRule(".ohb-slash-row", [
      "grid-template-columns: minmax(128px, 144px) minmax(136px, 1fr) minmax(148px, 1fr)",
    ]);
    expectCssRule(".ohb-slash-row-no-args", [
      "grid-template-columns: minmax(128px, 144px) minmax(0, 1fr)",
    ]);
    expectCssRule(".ohb-slash-row-no-args .ohb-slash-description", [
      "grid-column: 2",
    ]);
    expect(css).not.toContain(".ohb-slash-dot");
  });

  it("keeps every skill card track bounded and truncatable", () => {
    expectCssRule(".ohb-list-skill", [
      "display: grid",
      "grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)",
    ]);
  });

  it("reveals the tool disclosure arrow only on interaction or while open", () => {
    expectCssRule(".ohb-tool-chevron", ["opacity: 0"]);
    expectCssRule(
      '.ohb-tool-panel button:hover .ohb-tool-chevron,\n.ohb-tool-panel button:focus-visible .ohb-tool-chevron,\n.ohb-tool-panel button[aria-expanded="true"] .ohb-tool-chevron',
      ["opacity: 1"],
    );
  });

  it("floats the approval panel in the message area and reserves its height", () => {
    expectCssRule(".ohb-approval-layer", [
      "pointer-events: none",
      "position: absolute",
    ]);
    expectCssRule(".ohb-approval-panel", [
      "pointer-events: auto",
      "width: min(560px, 100%)",
    ]);
    expectCssRule(
      ".ohb-main-body.has-approval .ohb-root-conversation > .ohb-stream",
      ["padding-bottom: var(--approval-space, 176px)"],
    );
  });

  it("keeps modal layers fixed above the page", () => {
    expectCssRule(".ohb-full-access-layer", ["inset: 0", "position: fixed"]);
    expectCssRule(".ohb-directory-picker-layer", [
      "inset: 0",
      "position: fixed",
    ]);
    expectCssRule(".ohb-directory-picker-body", ["overflow-y: auto"]);
  });
});

function expectCssRule(
  selector: string,
  declarations: readonly string[],
): void {
  const rulePattern = new RegExp(
    `(?:^|\\}|\\*/)\\s*${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`,
  );
  const ruleBody = rulePattern.exec(css)?.groups?.body;

  expect(ruleBody, `missing CSS rule for ${selector}`).toBeDefined();
  const normalizedRuleBody = normalizeCss(ruleBody ?? "");
  for (const declaration of declarations) {
    expect(normalizedRuleBody).toContain(normalizeCss(declaration));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCss(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}
