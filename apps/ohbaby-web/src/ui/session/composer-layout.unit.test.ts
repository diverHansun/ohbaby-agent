// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

function stylesheet(url: URL): string {
  return readFileSync(url, "utf8").replace(
    /^@import "([^"]+)";$/gmu,
    (_line, path: string) => stylesheet(new URL(path, url)),
  );
}
afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});
it("keeps the empty-state composer in flow while anchoring chat and read-only composers to the main body", () => {
  const style = document.createElement("style");
  style.textContent = stylesheet(
    pathToFileURL(resolve("apps/ohbaby-web/src/ui/styles.css")),
  );
  document.head.append(style);
  document.body.innerHTML = `<div class="ohb-main-body ohb-main-body-empty"><div class="ohb-root-composer"><section id="empty" class="ohb-composer ohb-composer-hero"></section></div></div><div class="ohb-main-body ohb-main-body-chat"><div class="ohb-root-composer"><section id="main" class="ohb-composer"></section><section id="readonly" class="ohb-composer is-readonly"></section></div></div>`;
  const position = (id: string): string => {
    const element = document.getElementById(id);
    if (!element) throw new Error("Missing composer");
    return getComputedStyle(element).position;
  };
  expect(position("empty")).toBe("relative");
  expect(position("main")).toBe("absolute");
  expect(position("readonly")).toBe("absolute");
});
