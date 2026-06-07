import { describe, expect, it } from "vitest";
import { renderOhbabyLogo } from "./logo.js";

describe("renderOhbabyLogo", () => {
  it("renders the fixed FIGfont logo when there is enough width", () => {
    const lines = renderOhbabyLogo({ maxWidth: 80 });

    expect(lines.length).toBeGreaterThan(1);
    expect(Math.max(...lines.map((line) => line.length))).toBeGreaterThan(40);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
    expect(lines.join("\n")).not.toContain("___  _   _");
  });

  it("falls back to a compact wordmark on narrow terminals", () => {
    expect(renderOhbabyLogo({ maxWidth: 30 })).toEqual(["OHBABY"]);
  });
});
