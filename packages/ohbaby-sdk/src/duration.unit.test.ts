import { expect, it } from "vitest";
import * as sdk from "./index.js";
it.each([
  [0, "0s"],
  [59, "59s"],
  [60, "1m 0s"],
  [61, "1m 1s"],
  [3599, "59m 59s"],
  [3600, "1h 0m 0s"],
  [86400, "1d 0h 0m 0s"],
  [86399, "23h 59m 59s"],
  [93784, "1d 2h 3m 4s"],
])("formats %s whole seconds", (seconds, expected) => {
  expect(sdk.formatDurationSeconds(seconds)).toBe(expected);
});
it("advances from a server sample using only monotonic time and freezes terminal duration", () => {
  const anchor = sdk.createDurationAnchor({
    startedAt: 1000,
    serverNow: 6000,
    monotonicNow: 50,
  });
  expect(sdk.elapsedDurationMs(anchor, 2050)).toBe(7000);
  expect(
    sdk.elapsedDurationMs(
      sdk.createDurationAnchor({
        startedAt: 1000,
        endedAt: 7000,
        monotonicNow: 999999,
      }),
      9999999,
    ),
  ).toBe(6000);
  expect(
    sdk.createDurationAnchor({ startedAt: 1000, monotonicNow: 0 }),
  ).toBeUndefined();
  expect(
    sdk.elapsedDurationMs(
      sdk.createDurationAnchor({
        startedAt: 10000,
        serverNow: 1000,
        monotonicNow: 0,
      }),
      0,
    ),
  ).toBe(0);
});
