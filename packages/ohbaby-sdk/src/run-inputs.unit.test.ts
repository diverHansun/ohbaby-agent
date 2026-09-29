import { expect, it } from "vitest";
import type { UiRun } from "./snapshot.js";
import { hasUnsentSteerAfterLatestStop } from "./run-inputs.js";
const run = (id: string, patch: Partial<UiRun> = {}): UiRun => ({
  id,
  sessionId: "a",
  startedAt: "2026-01-01T00:00:00Z",
  status: { kind: "idle" },
  updatedAt: "2026-01-01T00:00:00Z",
  inputsCloseReason: "user-stop",
  unsentSteer: true,
  ...patch,
});
it("uses only the latest user Stop of the current root session, with stable ties", () => {
  expect(
    hasUnsentSteerAfterLatestStop(
      [run("old"), run("other", { sessionId: "b" })],
      "a",
    ),
  ).toBe(true);
  expect(
    hasUnsentSteerAfterLatestStop(
      [
        run("old"),
        run("new", { endedAt: "2026-01-02T00:00:00Z", unsentSteer: false }),
      ],
      "a",
    ),
  ).toBe(false);
  expect(
    hasUnsentSteerAfterLatestStop(
      [
        run("old"),
        run("finished", {
          inputsCloseReason: "completed",
          endedAt: "2026-01-02T00:00:00Z",
          unsentSteer: false,
        }),
      ],
      "a",
    ),
  ).toBe(true);
  expect(
    hasUnsentSteerAfterLatestStop(
      [run("z", { unsentSteer: false }), run("a")],
      "a",
    ),
  ).toBe(false);
  expect(
    hasUnsentSteerAfterLatestStop(
      [run("a"), run("z", { unsentSteer: false })],
      "a",
    ),
  ).toBe(false);
  expect(hasUnsentSteerAfterLatestStop([run("a")], "b")).toBe(false);
});
