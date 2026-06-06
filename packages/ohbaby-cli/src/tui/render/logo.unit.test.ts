import { describe, expect, it } from "vitest";
import { renderOhbabyLogo } from "./logo.js";

describe("renderOhbabyLogo", () => {
  it("returns a static multiline OHBABY ASCII logo", () => {
    const lines = renderOhbabyLogo();

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("OHBABY");
  });
});
