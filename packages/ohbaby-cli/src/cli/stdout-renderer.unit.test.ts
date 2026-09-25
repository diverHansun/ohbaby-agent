import { describe, expect, it } from "vitest";
import type { UiMessage, UiSessionChangedEvent } from "ohbaby-sdk";
import { createStdoutRenderer } from "./stdout-renderer.js";

function change(
  revision: number,
  messages: readonly UiMessage[],
  generation = "view",
): UiSessionChangedEvent {
  return {
    type: "session.changed",
    version: {
      runtimeEpoch: "epoch",
      sessionId: "session",
      viewGeneration: generation,
      sessionRevision: revision,
    },
    messages,
  };
}
function assistant(id: string, parts: UiMessage["parts"]): UiMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-09-25",
    status: "streaming",
    parts,
  };
}

describe("stdout source session messages", () => {
  it("prints only appended text per real message and part across model steps and repeated terminal upserts", () => {
    const chunks: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    renderer.handle(
      change(1, [
        assistant("step-1", [{ id: "part-1", type: "text", text: "Hel" }]),
      ]),
    );
    renderer.handle(
      change(2, [
        assistant("step-1", [{ id: "part-1", type: "text", text: "Hello" }]),
      ]),
    );
    renderer.handle(
      change(3, [
        assistant("step-1", [
          { id: "part-1", type: "text", text: "Hello" },
          { id: "part-2", type: "text", text: " world" },
        ]),
      ]),
    );
    const complete = {
      ...assistant("step-1", [
        { id: "part-1", type: "text", text: "Hello" },
        { id: "part-2", type: "text", text: " world" },
      ]),
      status: "completed" as const,
    };
    renderer.handle(
      change(4, [
        complete,
        assistant("step-2", [{ id: "part-3", type: "text", text: " again" }]),
      ]),
    );
    renderer.handle(
      change(5, [
        complete,
        {
          ...assistant("step-2", [
            { id: "part-3", type: "text", text: " again" },
          ]),
          status: "completed",
        },
      ]),
    );
    renderer.handle(change(1, [complete], "rebuilt"));
    expect(chunks).toEqual(["Hel", "lo", " world", " again"]);
  });
  it("ignores reasoning, user and tool records, and never reprints a shorter stale text prefix", () => {
    const chunks: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    renderer.handle(
      change(1, [
        {
          id: "user",
          role: "user",
          createdAt: "2026-09-25",
          parts: [{ id: "user-text", type: "text", text: "secret prompt" }],
        },
        assistant("step", [
          { id: "thinking", type: "reasoning", text: "private thinking" },
          { id: "answer", type: "text", text: "Answer" },
        ]),
        {
          id: "tool",
          role: "tool",
          createdAt: "2026-09-25",
          parts: [{ id: "tool-text", type: "text", text: "tool output" }],
        },
      ]),
    );
    renderer.handle(
      change(0, [
        assistant("step", [{ id: "answer", type: "text", text: "Ans" }]),
      ]),
    );
    renderer.handle(
      change(2, [
        assistant("step", [{ id: "answer", type: "text", text: "Answer!" }]),
      ]),
    );
    expect(chunks.join("")).toBe("Answer!");
  });
  it("keeps identified legacy deltas compatible without double output after source upserts", () => {
    const chunks: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    renderer.handle({
      type: "message.part.delta",
      sessionId: "session",
      messageId: "step",
      partId: "answer",
      delta: "Hel",
    });
    renderer.handle(
      change(1, [
        assistant("step", [{ id: "answer", type: "text", text: "Hello" }]),
      ]),
    );
    renderer.handle({
      type: "message.part.delta",
      sessionId: "session",
      messageId: "step",
      partId: "answer",
      content: "Hello",
      delta: "lo",
    });
    expect(chunks.join("")).toBe("Hello");
  });
});

describe("stdout source text appends", () => {
  it("uses UTF16 offsets and real part identities, ignores replay and reasoning, and accepts later full metadata upserts", () => {
    const chunks: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    renderer.handle(
      change(1, [
        assistant("m", [
          { id: "text", type: "text", text: "😀a" },
          { id: "reasoning", type: "reasoning", text: "private" },
        ]),
      ]),
    );
    const append = {
      ...change(2, []),
      textAppends: [
        { messageId: "m", partId: "text", offset: 3, text: "界🚀" },
        { messageId: "m", partId: "reasoning", offset: 7, text: " thought" },
      ],
    };
    renderer.handle(append);
    renderer.handle(append);
    renderer.handle({
      ...change(3, []),
      textAppends: [{ messageId: "m", partId: "text", offset: 6, text: "!" }],
    });
    renderer.handle(
      change(4, [
        {
          ...assistant("m", [{ id: "text", type: "text", text: "😀a界🚀!" }]),
          status: "completed",
        },
      ]),
    );
    expect(chunks).toEqual(["😀a", "界🚀", "!"]);
  });
  it("ignores unknown parts and mismatched offsets without poisoning later correct append or full recovery", () => {
    const chunks: string[] = [];
    const renderer = createStdoutRenderer({
      write: (chunk) => {
        chunks.push(chunk);
      },
    });
    renderer.handle({
      ...change(1, []),
      textAppends: [
        { messageId: "missing", partId: "p", offset: 0, text: "wrong" },
      ],
    });
    renderer.handle(
      change(2, [assistant("m", [{ id: "p", type: "text", text: "😀" }])]),
    );
    for (const offset of [1, 3, -1, 2.5])
      renderer.handle({
        ...change(3, []),
        textAppends: [{ messageId: "m", partId: "p", offset, text: "wrong" }],
      });
    renderer.handle({
      ...change(4, []),
      textAppends: [{ messageId: "m", partId: "p", offset: 2, text: "ok" }],
    });
    renderer.handle(
      change(5, [
        assistant("m", [{ id: "p", type: "text", text: "😀ok recovered" }]),
      ]),
    );
    expect(chunks).toEqual(["😀", "ok", " recovered"]);
  });
});
