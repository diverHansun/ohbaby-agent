import { expect, it } from "vitest";
import { shellJobStatusLine } from "./shell-job-notice.js";

it("reports captured bytes and unavailable logs without implying zero output", () => {
  expect(
    shellJobStatusLine({ status: "failed", outputBytes: 42, outputPath: null }),
  ).toContain("42 bytes captured");
  expect(
    shellJobStatusLine({ status: "failed", outputBytes: 42, outputPath: null }),
  ).toContain("unavailable");
});

it("states unknown bytes without inventing a zero count", () => {
  const line = shellJobStatusLine({
    status: "lost",
    outputBytes: null,
    outputPath: null,
    outputComplete: false,
  });
  expect(line).toContain("captured bytes unknown");
  expect(line).toContain("output incomplete");
  expect(line).not.toContain("0 bytes");
});
