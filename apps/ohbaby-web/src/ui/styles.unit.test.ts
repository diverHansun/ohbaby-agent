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
});

function expectCssRule(selector: string, declarations: readonly string[]): void {
  const rulePattern = new RegExp(
    `${escapeRegExp(selector)}\\s*\\{(?<body>[^}]*)\\}`,
  );
  const ruleBody = rulePattern.exec(css)?.groups?.body;

  expect(ruleBody, `missing CSS rule for ${selector}`).toBeDefined();
  for (const declaration of declarations) {
    expect(ruleBody).toContain(declaration);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
