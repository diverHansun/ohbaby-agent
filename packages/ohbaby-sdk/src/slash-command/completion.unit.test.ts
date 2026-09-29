import { describe, expect, it } from "vitest";
import { isUiCommandCompletion } from "./types.js";
const completion = {
  status: "completed",
  commandRunId: "r",
  clientInvocationId: "i",
  outputCount: 0,
  eventCount: 0,
};
const receipt = {
  promptId: "p",
  clientRequestId: "q",
  userMessageId: "m",
  sessionId: "s",
  status: "queued",
  createdAt: "2026-09-29T00:00:00Z",
};
describe("command completion transport guard", () => {
  it.each([
    null,
    4,
    {},
    { ...receipt, promptId: 1 },
    { ...receipt, sessionId: "" },
    { ...receipt, status: "unknown" },
    { ...receipt, createdAt: "not a date" },
  ])("rejects a malformed optional prompt receipt %j", (promptReceipt) => {
    expect(isUiCommandCompletion({ ...completion, promptReceipt })).toBe(false);
  });
  it.each([null, 4, ""])(
    "rejects malformed optional session identity %j",
    (sessionId) => {
      expect(isUiCommandCompletion({ ...completion, sessionId })).toBe(false);
    },
  );
  it("accepts output-only completion and the existing prompt receipt contract", () => {
    expect(isUiCommandCompletion(completion)).toBe(true);
    expect(
      isUiCommandCompletion({
        ...completion,
        promptReceipt: receipt,
        sessionId: "s",
      }),
    ).toBe(true);
  });
});
