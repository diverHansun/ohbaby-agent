import { expect, it } from "vitest";
import { shellJobStatusLine } from "./notice.js";

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

import { shellJobFixture } from "./fixtures/shell-job.js";
import {
  freezeShellJobNoticeBatch,
  renderShellJobNoticeBatch,
} from "./notice.js";

it("bounds complete notices by UTF-8 bytes and leaves whole jobs for another batch", () => {
  const jobs = Array.from({ length: 25 }, (_, index) =>
    shellJobFixture({
      jobId: `job-${String(index)}`,
      status: "completed",
      resultReadyAt: 10,
      command: "界".repeat(3000),
      description: "長".repeat(1000),
      outputTail: "🙂".repeat(2000),
      outputPath: "/" + "x".repeat(8000),
    }),
  );
  const frozen = freezeShellJobNoticeBatch("batch", jobs);
  expect(frozen.length).toBeGreaterThan(0);
  expect(frozen.length).toBeLessThan(20);
  const body = renderShellJobNoticeBatch(
    "batch",
    frozen.map((row) => row.payload),
  );
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(32 * 1024);
  expect(body).not.toContain("�");
  expect(frozen.map((row) => row.jobId)).toEqual(
    jobs.slice(0, frozen.length).map((row) => row.jobId),
  );
  expect(body).not.toContain(`Task job-${String(frozen.length)}:`);
});

it("caps batch count and describes an unfinished launch without inventing a running process", () => {
  const frozen = freezeShellJobNoticeBatch(
    "batch",
    Array.from({ length: 21 }, (_, index) =>
      shellJobFixture({
        jobId: `job-${String(index)}`,
        status: "lost",
        resultReadyAt: 10,
        pid: null,
        startedAt: null,
        outputComplete: false,
      }),
    ),
  );
  expect(frozen).toHaveLength(20);
  expect(frozen[0]?.payload).toContain("may or may not have started");
  expect(frozen[0]?.payload).toContain("output incomplete");
});
