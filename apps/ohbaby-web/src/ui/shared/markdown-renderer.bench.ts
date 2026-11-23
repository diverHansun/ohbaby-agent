// @vitest-environment jsdom
import { Marked } from "marked";
import { bench, describe } from "vitest";
import { markdown } from "./markdown-renderer.js";

const plain = new Marked();
const paragraph = "这是 **" + "未闭合的重点，后面很长 ".repeat(33);
const samples = {
  "one long paragraph": paragraph.repeat(200),
  "one unclosed marker per paragraph": Array(200).fill(paragraph).join("\n\n"),
};

for (const [name, text] of Object.entries(samples)) {
  describe(name, () => {
    bench("plain marked", () => {
      plain.parse(text, { async: false });
    });
    bench("CJK bold", () => {
      markdown.parse(text, { async: false });
    });
  });
}
