import { expect, it } from "vitest";
import type { UiSession } from "./snapshot.js";
import { getUnconsumedSteers } from "./run-inputs.js";

const session: UiSession = {
  id: "session",
  title: "Recovery",
  messages: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  unconsumedSteers: [
    {
      inputId: "input-1",
      promptId: "prompt-1",
      messageId: "old-message",
      text: "Keep the original requirement",
      state: "unconsumed",
    },
    {
      inputId: "input-2",
      promptId: "prompt-2",
      messageId: "attempted-message",
      text: "Check the result",
      state: "unconfirmed",
    },
  ],
};

it("keeps recovery entries even when their messages are outside the loaded page", () => {
  expect(getUnconsumedSteers(session).map((entry) => entry.inputId)).toEqual([
    "input-1",
    "input-2",
  ]);
  expect(getUnconsumedSteers(session)[1]?.state).toBe("unconfirmed");
});

it("handles sessions without recovery entries", () => {
  expect(getUnconsumedSteers(undefined)).toEqual([]);
  expect(
    getUnconsumedSteers({ ...session, unconsumedSteers: undefined }),
  ).toEqual([]);
  expect(getUnconsumedSteers(null)).toEqual([]);
});
