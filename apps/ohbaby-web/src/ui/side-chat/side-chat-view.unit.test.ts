import type { UiMessage, UiPromptSubmission, UiRun } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  createSideChatDraft,
  quoteSelection,
} from "../../runtime/side-chat.js";
import type { ViewModel } from "../session/selectors.js";
import { selectSideChatView } from "./side-chat-view.js";

const at = "2026-11-11T00:00:00.000Z";

function message(id: string, runId?: string): UiMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
    createdAt: at,
    ...(runId ? { runId } : {}),
  };
}

function prompt(
  promptId: string,
  userMessageId: string,
  clientRequestId: string,
  runId?: string,
): UiPromptSubmission {
  return {
    promptId,
    clientRequestId,
    scopeKey: "/repo",
    sessionId: "side",
    userMessageId,
    text: promptId,
    status: "succeeded",
    createdAt: at,
    updatedAt: at,
    ...(runId ? { runId } : {}),
  };
}

function run(id: string): UiRun {
  return {
    id,
    sessionId: "side",
    status: { kind: "idle" },
    startedAt: at,
    updatedAt: at,
  };
}

function view(messages: readonly UiMessage[]): ViewModel {
  const session = { id: "side", title: "Side chat 1", messages };
  return {
    activeSession: session,
    isEmpty: messages.length === 0,
    queuedPrompts: [],
    snapshot: {
      sessions: [session],
      prompts: [
        prompt("copied", "message_-copy_1", "copy:prompt_1", "run_-copy_1"),
        prompt("own", "own_1", "request_1", "run_own"),
      ],
      runs: [run("run_-copy_1"), run("run_own")],
    },
  } as unknown as ViewModel;
}

describe("selectSideChatView (T14)", () => {
  it("keeps only what came after the boundary", () => {
    const result = selectSideChatView(
      view([
        message("message_-copy_1", "run_-copy_1"),
        message("boundary"),
        message("own_1", "run_own"),
      ]),
      "boundary",
    );
    expect(result.boundaryLoaded).toBe(true);
    expect(result.view.activeSession?.messages.map((m) => m.id)).toEqual([
      "own_1",
    ]);
    expect(result.view.snapshot?.prompts?.map((p) => p.promptId)).toEqual([
      "own",
    ]);
    expect(result.view.snapshot?.runs.map((r) => r.id)).toEqual(["run_own"]);
    expect(result.view.isEmpty).toBe(false);
  });

  it("is empty when only inherited history and the boundary exist", () => {
    const result = selectSideChatView(
      view([message("message_-copy_1", "run_-copy_1"), message("boundary")]),
      "boundary",
    );
    expect(result.view.isEmpty).toBe(true);
  });

  it("treats a loaded page without the boundary as all its own", () => {
    const result = selectSideChatView(
      view([message("own_1", "run_own"), message("own_2", "run_own")]),
      "boundary",
    );
    expect(result.boundaryLoaded).toBe(false);
    expect(result.view.activeSession?.messages).toHaveLength(2);
    // Copied prompts and runs stay out even when their messages are not loaded.
    expect(result.view.snapshot?.prompts?.map((p) => p.promptId)).toEqual([
      "own",
    ]);
    expect(result.view.snapshot?.runs.map((r) => r.id)).toEqual(["run_own"]);
  });
});

describe("side chat quote (T16)", () => {
  it("quotes every line and leaves a blank line for the question", () => {
    expect(quoteSelection("one\n\ntwo\n")).toBe("> one\n>\n> two\n\n");
  });

  it("appends to what is typed and asks for focus once", () => {
    const draft = createSideChatDraft();
    draft.set("Why?");
    draft.quote("this line");
    expect(draft.getSnapshot().text).toBe("Why?\n\n> this line\n\n");
    expect(draft.consumeFocus()).toBe(true);
    expect(draft.consumeFocus()).toBe(false);
  });
});
