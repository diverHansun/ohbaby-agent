// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readMessageSelection } from "./SelectionAction.js";

function select(node: Node): Selection {
  const selection = document.getSelection();
  if (!selection) throw new Error("no selection");
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function must(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

describe("readMessageSelection (T16)", () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("reads text selected inside a message body of the stream", () => {
    document.body.innerHTML = `<section id="stream"><div class="ohb-message-body"><p>hello world</p></div></section>`;
    const stream = must("#stream");
    const text = must("#stream p");
    expect(readMessageSelection(select(text), stream)).toBe("hello world");
  });

  it("ignores an empty selection", () => {
    document.body.innerHTML = `<section id="stream"><div class="ohb-message-body"><p>hello</p></div></section>`;
    const stream = must("#stream");
    expect(readMessageSelection(document.getSelection(), stream)).toBeNull();
  });

  it("ignores text outside message bodies and in another stream", () => {
    document.body.innerHTML = `<section id="stream"><h2>title</h2></section><section id="other"><div class="ohb-message-body"><p>side</p></div></section>`;
    const stream = must("#stream");
    expect(readMessageSelection(select(must("#stream h2")), stream)).toBeNull();
    expect(readMessageSelection(select(must("#other p")), stream)).toBeNull();
  });
});
