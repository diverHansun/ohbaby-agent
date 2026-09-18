import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("web app layout styles", () => {
  it("keeps the composer docked while only the transcript scrolls", () => {
    expectCssRule(".ohb-sidebar", [
      "height: 100vh",
      "min-height: 0",
      "overflow: hidden",
    ]);
    expectCssRule(".ohb-app-content-main", [
      "height: 100vh",
      "min-height: 0",
      "overflow: hidden",
    ]);
    expectCssRule(".ohb-stream", ["min-height: 0", "overflow-y: auto"]);
    expectCssRule(".ohb-app-content-main > .ohb-composer", [
      "bottom: 0",
      "position: absolute",
    ]);
  });

  it("keeps slash command rows aligned across command, args, and description columns", () => {
    expectCssRule(".ohb-slash-row", [
      "grid-template-columns: 7px minmax(128px, 144px) minmax(136px, 1fr) minmax(148px, 1fr)",
    ]);
    expectCssRule(".ohb-slash-row em", ["text-align: left"]);
    expectCssRule(".ohb-slash-row-no-args", [
      "grid-template-columns: 7px minmax(128px, 144px) minmax(0, 1fr)",
    ]);
    expectCssRule(".ohb-slash-row-no-args .ohb-slash-args", ["display: none"]);
    expectCssRule(".ohb-slash-row-no-args .ohb-slash-description", [
      "grid-column: 3",
    ]);
  });

  it("keeps every skill card track bounded and truncatable", () => {
    expectCssRule(".ohb-list-skill", [
      "display: grid",
      "grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)",
    ]);
    expectCssRule(
      ".ohb-list-skill strong,\n.ohb-list-skill > span,\n.ohb-list-skill small",
      [
        "min-width: 0",
        "overflow: hidden",
        "text-overflow: ellipsis",
        "white-space: nowrap",
      ],
    );
  });

  it("keeps the animated placeholder behind and transparent to pointer input", () => {
    expectCssRule(".ohb-composer-typewriter", [
      "pointer-events: none",
      "position: absolute",
      "z-index: 0",
    ]);
    expectCssRule(".ohb-composer-typewriter-cursor", [
      "display: inline-block",
      "width: 1px",
    ]);
  });

  it("keeps composer actions circular without changing overlay buttons", () => {
    expectCssRule(".ohb-send-button,\n.ohb-stop-button", [
      "border-radius: 50%",
      "height: 32px",
      "padding: 0",
      "width: 32px",
    ]);
    expectCssRule(".ohb-button", [
      "background: #ffffff",
      "border: 1px solid #e4e4e4",
      "color: #6b6d73",
    ]);
    expectCssRule(".ohb-button-primary", ["border-radius: 8px"]);
    expect(css).not.toMatch(
      /\.ohb-composer-input\s*\{\s*align-items:\s*stretch/u,
    );
  });

  it("supports a bounded, contained composer textarea scroll", () => {
    expectCssRule(".ohb-composer textarea", [
      "line-height: 24px",
      "max-height: 168px",
      "overflow-y: auto",
      "overscroll-behavior: contain",
      "padding: 0",
    ]);
  });

  it("renders status and tool names without nested chrome", () => {
    expectCssRule(".ohb-status-pill", [
      "background: transparent",
      "border: 0",
      "padding: 0",
    ]);
    expectCssRule(".ohb-status-running", ["animation: ohb-pulse"]);
    expectCssRule(".ohb-status-resyncing", ["animation: none"]);
    expectCssRule(".ohb-tool-panel button span:first-child", [
      "background: transparent",
      "border: 0",
      "padding: 0",
    ]);
    expectCssRule(".ohb-tool-panel", [
      "background: #ffffff",
      "border: 1px solid #ececec",
    ]);
  });

  it("keeps every tool disclosure arrow visible when its summary is long", () => {
    expectCssRule(".ohb-tool-summary", ["flex: 1", "min-width: 0"]);
    expectCssRule(".ohb-tool-chevron", [
      "flex: none",
      "height: 14px",
      "width: 14px",
    ]);
  });

  it("centers one-line composer text without changing multiline sizing", () => {
    expectCssRule(".ohb-composer-input", ["align-items: flex-end"]);
    expectCssRule(".ohb-composer-text", [
      "align-items: center",
      "min-height: 32px",
    ]);
    expect(css).not.toMatch(/\.ohb-prompt\s*\{/u);
    expectCssRule(".ohb-prompt-queue", ["position: relative"]);
  });

  it("shortens only the conversation header", () => {
    expectCssRule(".ohb-statusbar", ["min-height: 44px", "padding: 8px 24px"]);
    expectCssRule(".ohb-sidebar-header", ["min-height: 58px"]);
    const narrowHeader =
      /@media \(max-width: 720px\)[\s\S]*?\.ohb-statusbar\s*\{(?<body>[^}]*)\}/u.exec(
        css,
      )?.groups?.body;
    expect(narrowHeader).toContain("padding: 8px 16px");
  });

  it("defines isolated permission button consequence styles", () => {
    expectCssRule(".ohb-perm-btn", [
      "align-items: center",
      "border: 1px solid transparent",
      "border-radius: 8px",
      "display: inline-flex",
      "font-size: 13px",
      "font-weight: 500",
      "gap: 7px",
      "justify-content: center",
      "min-height: 36px",
      "padding: 0 13px",
    ]);
    expectCssRule(".ohb-perm-allow-primary", [
      "background: #5f86c4",
      "border-color: #5278bb",
      "color: #ffffff",
    ]);
    expectCssRule(".ohb-perm-allow-primary:hover", ["background: #5278bb"]);
    expectCssRule(".ohb-perm-allow-secondary", [
      "background: #eef2f9",
      "border-color: #d8e1f0",
      "color: #4a6ba6",
    ]);
    expectCssRule(".ohb-perm-allow-secondary:hover", ["background: #e3ebf6"]);
    expectCssRule(".ohb-perm-deny", [
      "background: #faf3e4",
      "border-color: #ead7ad",
      "color: #8f6f2f",
    ]);
    expectCssRule(".ohb-perm-deny:hover", ["background: #f4ead2"]);
    expectCssRule(".ohb-perm-abort", [
      "background: rgba(196, 117, 107, 0.16)",
      "border-color: #c4756b",
      "color: #a0493d",
      "margin-left: 6px",
    ]);
    expectCssRule(".ohb-perm-abort:hover", [
      "background: rgba(196, 117, 107, 0.24)",
    ]);
  });

  it("keeps the directory picker contained as a modal with a scrollable directory list", () => {
    expectCssRule(".ohb-directory-picker-layer", [
      "inset: 0",
      "position: fixed",
      "z-index: 60",
    ]);
    expectCssRule(".ohb-directory-picker-dialog", [
      "max-height: 84vh",
      "overflow: hidden",
      "width: 640px",
    ]);
    expectCssRule(".ohb-directory-picker-body", [
      "min-height: 220px",
      "overflow-y: auto",
    ]);
    expectCssRule(".ohb-directory-picker-list", ["display: grid", "gap: 4px"]);
    expectCssRule(".ohb-directory-picker-breadcrumb", [
      "overflow-x: auto",
      "white-space: nowrap",
    ]);
    expectCssRule(".ohb-directory-picker-breadcrumb span", ["flex: 0 0 auto"]);
  });
});

function expectCssRule(
  selector: string,
  declarations: readonly string[],
): void {
  const rulePattern = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`,
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
