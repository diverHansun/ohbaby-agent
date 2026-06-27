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
