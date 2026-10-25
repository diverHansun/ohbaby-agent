// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { focusableIn } from "./focus-trap.js";

afterEach(() => {
  document.body.replaceChildren();
});

it("excludes controls hidden by responsive CSS, including hidden ancestors", () => {
  document.body.innerHTML = `<section>
    <button style="display:none">Phone back</button>
    <button>Close</button>
    <nav style="display:none"><button>Models</button></nav>
    <button style="visibility:hidden">Hidden</button>
    <button>Save</button>
  </section>`;
  const section = document.querySelector("section");
  if (!section) throw new Error("Expected dialog");
  expect(focusableIn(section).map((item) => item.textContent)).toEqual([
    "Close",
    "Save",
  ]);
});
