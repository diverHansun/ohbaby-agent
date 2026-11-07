import { describe, expect, it } from "vitest";
import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
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
    // A prompt without a run identifies no turn; its messages stay as they are.
    expect(
      project(
        [
          msg("progress", { runId: undefined }),
          msg("answer", { runId: undefined }),
        ],
        { runId: undefined },
      ),
    ).toBeUndefined();
    expect(projectRunProcesses([msg("answer")], [prompt], "other", {})).toEqual(
      [],
    );
  });
});

function run(id: string, patch: Partial<UiRun> = {}): UiRun {
  return {
    id,
    sessionId: "s",
    status: { kind: "idle" },
    startedAt: "2026-09-29T00:01:00Z",
    endedAt: "2026-09-29T00:01:05Z",
    updatedAt: "2026-09-29T00:01:05Z",
    trigger: "subagent",
    outcome: "succeeded",
    ...patch,
  };
}

describe("turns by run (turn-projection)", () => {
  it("makes each subagent wake-up its own folded turn with run timing (T7)", () => {
    const turns = projectRunProcesses(
      [
        msg("user", { role: "user" }),
        msg("answer"),
        msg("w-progress", { runId: "w" }),
        msg("w-answer", { runId: "w" }),
      ],
      [prompt],
      "s",
      {},
      [run("r", { trigger: "user" }), run("w")],
    );
    expect(turns.map((turn) => [turn.runId, turn.trigger])).toEqual([
      ["r", "user"],
      ["w", "subagent"],
    ]);
    const wake = turns[1];
    expect(wake.answerId).toBe("w-answer");
    expect(wake.processIds).toEqual(["w-progress"]);
    expect(wake.foldable).toBe(true);
    expect(wake.prompt).toBeUndefined();
    expect(wake.timing).toMatchObject({
      startedAt: "2026-09-29T00:01:00Z",
      endedAt: "2026-09-29T00:01:05Z",
      status: "succeeded",
    });
  });

  it("keeps a user turn on its prompt's acceptance time", () => {
    const [turn] = projectRunProcesses(
      [msg("answer")],
      [{ ...prompt, acceptedAt: "2026-09-29T00:00:03Z" }],
      "s",
      {},
      [run("r", { trigger: "user", startedAt: "2026-09-29T00:00:04Z" })],
    );
    expect(turn.timing.startedAt).toBe("2026-09-29T00:00:03Z");
    expect(turn.timing.id).toBe("p");
  });

  it("drops a run that wrote no messages (T7b)", () => {
    const turns = projectRunProcesses([msg("answer")], [prompt], "s", {}, [
      run("r", { trigger: "user" }),
      run("empty", { outcome: "failed" }),
    ]);
    expect(turns.map((turn) => turn.runId)).toEqual(["r"]);
  });

  it("folds a goal turn without a prompt and leaves it unlabelled (T8)", () => {
    const [turn] = projectRunProcesses(
      [
        msg("goal-text", { runId: "g", role: "user" }),
        msg("g-progress", { runId: "g" }),
        msg("g-answer", { runId: "g" }),
      ],
      [],
      "s",
      {},
      [run("g", { trigger: "goal" })],
    );
    expect(turn.trigger).toBe("goal");
    expect(turn.foldable).toBe(true);
    expect(turn.answerId).toBe("g-answer");
  });

  it("labels old wake-ups only when the run opened on a subagent status (T10)", () => {
    const opening = msg("status", {
      runId: "old",
      role: "user",
      runtimeInputKind: "subagent-status",
    });
    const midway = msg("result", {
      runId: "mid",
      role: "user",
      runtimeInputKind: "subagent-result",
    });
    const turns = projectRunProcesses(
      [
        msg("old-answer", { runId: "old" }),
        msg("mid-answer", { runId: "mid" }),
      ],
      [],
      "s",
      {},
      [
        run("old", { trigger: "user", startedAt: "2026-09-29T00:01:00Z" }),
        run("mid", { trigger: "user", startedAt: "2026-09-29T00:02:00Z" }),
      ],
      [
        opening,
        msg("old-answer", { runId: "old" }),
        midway,
        msg("mid-answer", { runId: "mid" }),
      ],
    );
    expect(turns.map((turn) => turn.trigger)).toEqual(["subagent", "user"]);
    expect(turns[1].answerId).toBe("mid-answer");
  });

  it("answers a stopped or failed turn from its last message only, without folding (T11)", () => {
    const note = {
      type: "text" as const,
      text: "[Response cancelled by the user.]",
      metadata: { kind: "lifecycle-interruption" },
    };
    const [stopped] = projectRunProcesses(
      [
        msg("progress"),
        msg("partial", {
          status: "error",
          parts: [{ type: "text", text: "Half an answer" }, note],
        }),
      ],
      [],
      "s",
      {},
      [run("r", { outcome: "cancelled" })],
    );
    expect(stopped.answerId).toBe("partial");
    expect(stopped.foldable).toBe(false);
    const [noteOnly] = projectRunProcesses(
      [msg("earlier"), msg("last", { status: "error", parts: [note] })],
      [],
      "s",
      {},
      [run("r", { outcome: "cancelled" })],
    );
    // The last message has no model text; an earlier one is not used instead.
    expect(noteOnly.answerId).toBeUndefined();
    expect(noteOnly.afterId).toBe("last");
  });

  it("orders turns by run start and ignores other sessions (T12)", () => {
    const turns = projectRunProcesses(
      [msg("b", { runId: "b" }), msg("a", { runId: "a" })],
      [],
      "s",
      {},
      [
        run("b", { startedAt: "2026-09-29T00:03:00Z" }),
        run("a", { startedAt: "2026-09-29T00:02:00Z" }),
        run("x", { sessionId: "other" }),
      ],
    );
    expect(turns.map((turn) => turn.runId)).toEqual(["a", "b"]);
  });

  it("falls back field by field when a run lacks outcome or trigger (T14)", () => {
    const bare = run("r", { trigger: undefined, outcome: undefined });
    const [withPrompt] = projectRunProcesses(
      [msg("progress"), msg("answer")],
      [prompt],
      "s",
      {},
      [bare],
    );
    expect(withPrompt.timing.status).toBe("succeeded");
    expect(withPrompt.foldable).toBe(true);
    const [withoutPrompt] = projectRunProcesses(
      [msg("progress"), msg("answer")],
      [],
      "s",
      {},
      [bare],
    );
    expect(withoutPrompt.trigger).toBe("user");
    expect(withoutPrompt.timing.status).toBeUndefined();
    expect(withoutPrompt.foldable).toBe(false);
    expect(withoutPrompt.answerId).toBe("answer");
  });
});

describe("turn anchors", () => {
  it("keeps a failed user turn that wrote nothing on its prompt message", () => {
    const [turn] = projectRunProcesses(
      [msg("user", { role: "user", runId: undefined })],
      [{ ...prompt, status: "failed" }],
      "s",
      {},
      [run("r", { trigger: "user", outcome: "failed" })],
    );
    expect(turn.afterId).toBe("user");
    expect(turn.answerId).toBeUndefined();
    expect(turn.timing.status).toBe("failed");
  });

  it("does not make a turn of a wake-up that only received hidden inputs", () => {
    const turns = projectRunProcesses(
      [],
      [],
      "s",
      {},
      [run("w")],
      [
        msg("status", {
          runId: "w",
          role: "user",
          runtimeInputKind: "subagent-status",
        }),
      ],
    );
    expect(turns).toEqual([]);
  });
});
