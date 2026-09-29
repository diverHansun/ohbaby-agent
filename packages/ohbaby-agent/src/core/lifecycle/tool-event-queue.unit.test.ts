import { expect, it } from "vitest";
import { ToolBatchEventQueue } from "./tool-event-queue.js";
import type { LifecycleEvent } from "./types.js";
const state = (
  callId: string,
  timestamp: number,
): Extract<LifecycleEvent, { type: "tool:state" }> => ({
  type: "tool:state",
  runId: "run",
  sessionId: "session",
  messageId: "message",
  partId: `part-${callId}`,
  callId,
  toolName: "work",
  params: {},
  step: 1,
  timestamp,
  execution: {
    runId: "run",
    phase: "queued",
    createdAt: 1,
    phaseStartedAt: timestamp,
  },
});
const result = (
  callId: string,
): Extract<LifecycleEvent, { type: "tool:result" }> => ({
  ...state(callId, 1000),
  type: "tool:result",
  result: {
    callId,
    status: "success",
    output: "done",
    execution: {
      runId: "run",
      phase: "ended",
      createdAt: 1,
      phaseStartedAt: 1000,
      endedAt: 1000,
      outcome: "success",
    },
  },
});
it("coalesces unconsumed states and derives terminal protection from the result event", async () => {
  const queue = new ToolBatchEventQueue();
  for (let i = 0; i < 1000; i++) {
    queue.push(state("a", i));
    queue.push(state("b", i));
  }
  const terminal = result("a");
  queue.push(terminal);
  queue.push(state("a", 1001));
  queue.push(result("a"));
  queue.close();
  const received = [];
  for await (const event of queue.events()) received.push(event);
  expect(received).toEqual([terminal, state("b", 999)]);
});
it("fatal wakes an idle consumer and takes precedence over buffered states", async () => {
  const queue = new ToolBatchEventQueue();
  const waiting = queue.events().next();
  queue.fail(new Error("fatal"));
  await expect(waiting).rejects.toThrow("fatal");
  const buffered = new ToolBatchEventQueue();
  buffered.push(state("a", 1));
  buffered.fail(new Error("fatal"));
  await expect(buffered.events().next()).rejects.toThrow("fatal");
});
