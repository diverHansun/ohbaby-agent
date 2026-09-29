import { describe, expect, it } from "vitest";
import type { UiMessage, UiPromptSubmission } from "ohbaby-sdk";
import { projectRunProcesses } from "./run-process.js";

const prompt: UiPromptSubmission = {
  promptId: "p",
  clientRequestId: "c",
  scopeKey: "scope",
  sessionId: "s",
  userMessageId: "user",
  text: "question",
  status: "succeeded",
  runId: "r",
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:10Z",
  endedAt: "2026-09-29T00:00:10Z",
};
function msg(id: string, patch: Partial<UiMessage> = {}): UiMessage {
  return {
    id,
    runId: "r",
    role: "assistant",
    status: "completed",
    createdAt: prompt.createdAt,
    parts: [{ type: "text", text: id }],
    ...patch,
  };
}
function project(
  messages: UiMessage[],
  patch: Partial<UiPromptSubmission> = {},
  extra: UiPromptSubmission[] = [],
): ReturnType<typeof projectRunProcesses>[number] {
  return projectRunProcesses(
    messages,
    [{ ...prompt, ...patch }, ...extra],
    "s",
    {},
  )[0];
}

describe("run process eligibility", () => {
  it("folds only explicitly owned work and keeps the last answer", () => {
    const result = project([
      msg("user", { role: "user" }),
      msg("progress"),
      msg("unknown", { runId: undefined }),
      msg("other", { runId: "other" }),
      msg("answer"),
    ]);
    expect(result.answerId).toBe("answer");
    expect(result.processIds).toEqual(["progress"]);
    expect(result.foldable).toBe(true);
  });
  it.each(["failed", "cancelled", "interrupted"] as const)(
    "keeps %s expanded",
    (status) => {
      expect(
        project([msg("progress"), msg("answer")], { status }).foldable,
      ).toBe(false);
    },
  );
  it("waits for the final message and reasoning to finish", () => {
    expect(
      project([msg("progress"), msg("answer", { status: "streaming" })])
        .foldable,
    ).toBe(false);
    expect(
      project([
        msg("thinking", { parts: [{ type: "reasoning", text: "hmm" }] }),
        msg("answer"),
      ]).foldable,
    ).toBe(false);
    expect(
      projectRunProcesses(
        [msg("progress"), msg("answer")],
        [{ ...prompt, status: "running", endedAt: undefined }],
        "s",
        {},
      ),
    ).toEqual([]);
  });
  it("does not reuse old progress as the answer when the last assistant is empty or tool-only", () => {
    for (const parts of [
      [],
      [{ type: "text" as const, text: " " }],
      [
        {
          type: "tool-call" as const,
          call: {
            id: "call",
            name: "read",
            input: {},
            status: "completed" as const,
          },
        },
      ],
    ]) {
      expect(
        project([msg("progress"), msg("last", { parts })]).answerId,
      ).toBeUndefined();
      expect(project([msg("progress"), msg("last", { parts })]).foldable).toBe(
        false,
      );
    }
  });
  it("counts final-message reasoning but does not offer an empty disclosure", () => {
    expect(project([msg("answer")]).foldable).toBe(false);
    expect(
      project([
        msg("answer", {
          parts: [
            { type: "reasoning", text: "hmm", endReason: "normal" },
            { type: "text", text: "answer" },
          ],
        }),
      ]).foldable,
    ).toBe(true);
  });
  it("uses steer provenance or receipt, never a nearby queued prompt", () => {
    expect(
      project([
        msg("progress"),
        msg("steer", { role: "user", runtimeInputKind: "user-steer" }),
        msg("answer"),
      ]).foldable,
    ).toBe(false);
    const queued = {
      ...prompt,
      promptId: "q",
      status: "queued" as const,
      runId: undefined,
      endedAt: undefined,
    };
    expect(
      project([msg("progress"), msg("answer")], {}, [queued]).foldable,
    ).toBe(true);
    expect(
      project([msg("progress"), msg("answer")], {}, [
        {
          ...queued,
          status: "steered",
          steerReceipt: {
            promptId: "q",
            userMessageId: "steer",
            inputId: "input",
            acceptedTargetRunId: "r",
            acceptedAt: Date.parse(prompt.createdAt),
            clientRequestId: "steer-request",
          },
        },
      ]).foldable,
    ).toBe(false);
  });
  it("does not associate absent run IDs or other sessions", () => {
    expect(
      project(
        [
          msg("progress", { runId: undefined }),
          msg("answer", { runId: undefined }),
        ],
        { runId: undefined },
      ).foldable,
    ).toBe(false);
    expect(projectRunProcesses([msg("answer")], [prompt], "other", {})).toEqual(
      [],
    );
  });
});
