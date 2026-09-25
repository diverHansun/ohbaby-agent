import { describe, expect, it } from "vitest";
import {
  applySessionChange,
  sameSessionGeneration,
  type UiSessionView,
} from "./session-view.js";
const view: UiSessionView = {
  version: {
    runtimeEpoch: "runtime",
    sessionId: "s",
    viewGeneration: "view",
    sessionRevision: 2,
  },
  session: {
    id: "s",
    title: "test",
    createdAt: "2026",
    updatedAt: "2026",
    messages: [
      {
        id: "m",
        role: "assistant",
        createdAt: "2026",
        parts: [{ type: "text", text: "first" }],
      },
    ],
  },
  runs: [],
  prompts: [],
  history: { hasMore: false },
  reasoningMissing: false,
  todo: { status: "ready", value: null },
  goal: { status: "ready", value: null },
  context: { status: "ready", value: null },
};
describe("session cut reconciliation", () => {
  it("replaces a real message once, ignores duplicates, and refuses gaps", () => {
    const event = {
      type: "session.changed" as const,
      version: { ...view.version, sessionRevision: 3 },
      messages: [
        {
          ...view.session.messages[0],
          parts: [{ type: "text" as const, text: "first second" }],
        },
      ],
    };
    const next = applySessionChange(view, event);
    if (!next) throw new Error("Change was not accepted");
    expect(next.session.messages).toHaveLength(1);
    expect(next.session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "first second",
    });
    expect(applySessionChange(next, event)).toBe(next);
    expect(
      applySessionChange(view, {
        ...event,
        version: { ...event.version, sessionRevision: 4 },
      }),
    ).toBeUndefined();
    expect(view.session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "first",
    });
  });
  it("never compares revisions across runtime/session/view identities", () => {
    for (const patch of [
      { runtimeEpoch: "other" },
      { sessionId: "other" },
      { viewGeneration: "other" },
    ]) {
      const version = { ...view.version, ...patch, sessionRevision: 3 };
      expect(sameSessionGeneration(view.version, version)).toBe(false);
      expect(
        applySessionChange(view, { type: "session.changed", version }),
      ).toBeUndefined();
    }
  });
});

describe("revisioned text appends", () => {
  const base: UiSessionView = {
    ...view,
    session: {
      ...view.session,
      messages: [
        {
          ...view.session.messages[0],
          parts: [
            { id: "text", type: "text", text: "中😀" },
            {
              id: "reasoning",
              type: "reasoning",
              text: "why",
              saveState: "pending",
            },
          ],
        },
      ],
    },
  };
  it("applies UTF16 offsets to identified text and reasoning without mutating the baseline", () => {
    const event = {
      type: "session.changed" as const,
      version: { ...view.version, sessionRevision: 3 },
      textAppends: [
        { messageId: "m", partId: "text", offset: 3, text: "next" },
        { messageId: "m", partId: "reasoning", offset: 3, text: " now" },
      ],
    };
    const next = applySessionChange(base, event);
    expect(next?.session.messages[0]?.parts).toEqual([
      { id: "text", type: "text", text: "中😀next" },
      {
        id: "reasoning",
        type: "reasoning",
        text: "why now",
        saveState: "pending",
      },
    ]);
    expect(base.session.messages[0]?.parts[0]).toMatchObject({ text: "中😀" });
    if (!next) throw new Error("Expected append");
    expect(applySessionChange(next, event)).toBe(next);
  });
  it.each([
    { messageId: "missing", partId: "text", offset: 3, text: "x" },
    { messageId: "m", partId: "missing", offset: 3, text: "x" },
    { messageId: "m", partId: "text", offset: 2, text: "x" },
    { messageId: "m", partId: "text", offset: -1, text: "x" },
    { messageId: "m", partId: "", offset: 3, text: "x" },
  ])("refuses an append with mismatched identity or offset: %j", (append) => {
    expect(
      applySessionChange(base, {
        type: "session.changed",
        version: { ...view.version, sessionRevision: 3 },
        textAppends: [append],
      }),
    ).toBeUndefined();
  });
});
