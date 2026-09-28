import { expect, it } from "vitest";
import type { UiMessage, UiSubagentExecution, UiToolCall } from "ohbaby-sdk";
import { delegationExecution } from "./DelegationRow.js";
const call: UiToolCall = {
  id: "tool",
  name: "subagent_run",
  input: { prompt: "task" },
  status: "completed",
};
const message: UiMessage = {
  id: "message",
  role: "assistant",
  runId: "run",
  createdAt: "2026-01-01",
  parts: [{ type: "tool-call", call }],
};
const execution: UiSubagentExecution = {
  executionId: "execution",
  subagentId: "worker",
  rootSessionId: "root",
  rootRunId: "run",
  requestId: JSON.stringify([message.id, call.id]),
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
  resultStored: true,
  delivery: "foreground",
};
it("joins delegation by exact message and call identity within the authorized root", () => {
  expect(delegationExecution(message, call, [execution], "root")).toBe(
    execution,
  );
  expect(
    delegationExecution({ ...message, id: "other" }, call, [execution], "root"),
  ).toBeUndefined();
  expect(
    delegationExecution(message, call, [execution], "other-root"),
  ).toBeUndefined();
});
it("opens legacy result metadata without inventing a parent anchor", () => {
  const legacy = {
    ...message,
    parts: [
      ...message.parts,
      {
        type: "tool-result" as const,
        result: { callId: call.id, output: "done" },
        metadata: {
          subagent: {
            execution: {
              executionId: "old",
              subagentId: "worker",
              status: "completed",
              childSessionId: "child",
            },
          },
        },
      },
    ],
  };
  const result = delegationExecution(legacy, call, [], "root");
  expect(result?.executionId).toBe("old");
  expect(result?.childUserMessageId).toBeUndefined();
});
