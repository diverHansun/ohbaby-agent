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
  it("shows automatic failures before the first message, without surfacing silent success or Stop", () => {
    const error = {
      code: "INTERNAL",
      message: "Input admission failed",
      source: "runtime" as const,
      retryable: false,
    };
    const turns = listEndedTurns({
      sessionId: "s",
      prompts: [],
      messages: [],
      runs: [
        run("failed", { trigger: "subagent", outcome: "failed", error }),
        run("interrupted", { trigger: "goal", outcome: "interrupted", error }),
        run("success", { trigger: "subagent" }),
        run("stop", { trigger: "subagent", outcome: "cancelled", error }),
      ],
    });
    expect(turns.map((turn) => [turn.runId, turn.error?.message])).toEqual([
      ["failed", "Input admission failed"],
      ["interrupted", "Input admission failed"],
    ]);
  });
  it("chooses one error per visible failed turn with session and terminal boundaries", () => {
    const error = {
      code: "PROVIDER_API",
      message: "Limited",
      source: "provider" as const,
      retryable: true,
    };
    const runs = [
      run("r1", { outcome: "failed", error }),
      run("wake", { outcome: "failed", error }),
      run("empty", { outcome: "failed", error }),
      run("foreign", { sessionId: "side", outcome: "failed", error }),
      run("stopped", { outcome: "cancelled", error }),
    ];
    const messages = [
      answer("wake-message", "wake"),
      answer("stop-message", "stopped"),
    ];
    const input = {
      sessionId: "s",
      runs,
      messages,
      prompts: [
        prompt({
          status: "failed",
          error: { ...error, message: "Prompt error" },
        }),
      ],
    };
    expect(
      listEndedTurns(input).map((turn) => [turn.runId, turn.error?.message]),
    ).toEqual([
      ["r1", "Prompt error"],
      ["stopped", undefined],
      ["wake", "Limited"],
    ]);
    expect(
      listEndedTurns({
        ...input,
        prompts: [prompt({ status: "running" })],
      }).map((turn) => turn.runId),
    ).toEqual(["stopped", "wake"]);
    expect(
      listEndedTurns({ ...input, runs: [], prompts: [], messages: [] }),
    ).toEqual([]);
  });
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
