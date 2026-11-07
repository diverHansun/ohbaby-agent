import { describe, expect, it } from "vitest";
import type { UiPromptSubmission } from "../contract/prompt.js";
import type { UiMessage, UiRun } from "../contract/snapshot.js";
import { listEndedTurns } from "./turn.js";

const prompt = (
  patch: Partial<UiPromptSubmission> = {},
): UiPromptSubmission => ({
  promptId: "p1",
  clientRequestId: "c1",
  scopeKey: "s",
  sessionId: "s",
  userMessageId: "user",
  text: "Ask",
  status: "succeeded",
  runId: "r1",
  createdAt: "2026-01-01T00:00:00Z",
  acceptedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:16Z",
  endedAt: "2026-01-01T00:00:16Z",
  ...patch,
});
const run = (id: string, patch: Partial<UiRun> = {}): UiRun => ({
  id,
  sessionId: "s",
  status: { kind: "idle" },
  startedAt: "2026-01-01T00:00:10Z",
  endedAt: "2026-01-01T00:00:14Z",
  updatedAt: "2026-01-01T00:00:14Z",
  trigger: "user",
  outcome: "succeeded",
  ...patch,
});
const answer = (id: string, runId: string): UiMessage => ({
  id,
  role: "assistant",
  runId,
  createdAt: "2026-01-01T00:00:12Z",
  parts: [{ type: "text", text: "Done" }],
});

describe("listEndedTurns", () => {
  it("waits for a run's prompt to end, then times the turn by the prompt", () => {
    const input = {
      sessionId: "s",
      runs: [run("r1")],
      messages: [answer("a1", "r1")],
    };
    // The run reports its end before its prompt does.
    expect(
      listEndedTurns({ ...input, prompts: [prompt({ status: "running" })] }),
    ).toEqual([]);
    expect(
      listEndedTurns({ ...input, prompts: [prompt()] })[0]?.timing,
    ).toEqual({
      id: "p1",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:16Z",
      status: "succeeded",
      recovered: false,
    });
  });

  it("orders turns by run start, not by when a queued prompt was accepted", () => {
    const turns = listEndedTurns({
      sessionId: "s",
      // Queued at 00:00, ran after the wake-up that started at 00:05.
      prompts: [prompt({ endedAt: "2026-01-01T00:00:20Z" })],
      runs: [
        run("r1", { startedAt: "2026-01-01T00:00:10Z" }),
        run("wake", {
          trigger: "subagent",
          startedAt: "2026-01-01T00:00:05Z",
          endedAt: "2026-01-01T00:00:08Z",
        }),
      ],
      messages: [answer("a-wake", "wake"), answer("a1", "r1")],
    });
    expect(turns.map((turn) => turn.runId)).toEqual(["wake", "r1"]);
  });
});
