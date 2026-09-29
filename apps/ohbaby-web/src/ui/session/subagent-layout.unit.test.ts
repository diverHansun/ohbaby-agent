import { expect, it } from "vitest";
import { subagentSheetGeometry } from "./subagent-layout.js";
it("aligns with the actual composer and leaves a ten-pixel vertical gap", () => {
  const result = subagentSheetGeometry(
    { left: 300, right: 1500, bottom: 900, width: 1200 },
    { left: 450, top: 700, width: 800 },
    44,
    false,
  );
  expect(result.left + 300).toBe(450);
  expect(result.width).toBe(800);
  expect(900 - result.bottom).toBe(690);
  expect(result.height).toBeLessThanOrEqual(680);
});
it("clamps a viewport-centered composer to the main column without changing its rectangle", () => {
  const composer = { left: 250, top: 700, width: 800 };
  const result = subagentSheetGeometry(
    { left: 400, right: 1400, bottom: 900, width: 1000 },
    composer,
    44,
    false,
  );
  expect(result.left).toBe(24);
  expect(result.left + result.width).toBeLessThanOrEqual(976);
  expect(composer).toEqual({ left: 250, top: 700, width: 800 });
});
it("keeps narrow sheets inside both gutters", () => {
  const result = subagentSheetGeometry(
    { left: 80, right: 400, bottom: 800, width: 320 },
    { left: 0, top: 600, width: 400 },
    80,
    true,
  );
  expect(result.left).toBe(14);
  expect(result.width).toBe(292);
  expect(result.left + result.width).toBe(306);
});
