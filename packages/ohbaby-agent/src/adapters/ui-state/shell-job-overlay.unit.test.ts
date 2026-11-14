import { describe, expect, it } from "vitest";
import type { UiMessage } from "ohbaby-sdk";
import { shellJobFixture } from "../../shell-jobs/fixtures/shell-job.js";
import { overlayShellJobFacts } from "./persistent-store.js";

describe("saved shell result overlay", () => {
  it("updates only a complete same-session call identity and retains the saved part", () => {
    const message: UiMessage = {
      id: "message",
      role: "assistant",
      createdAt: new Date(0).toISOString(),
      parts: [
        {
          type: "tool-result",
          id: "part",
          result: {
            callId: "call",
            output: "old",
            outputAvailable: true,
            details: { kind: "bash", jobId: "job", status: "running" },
          },
        },
      ],
    };
    const row = shellJobFixture({
      messageId: "message",
      callId: "call",
      status: "cancelled",
      stopReason: "user",
      cleanup: "confirmed",
    });
    const store = { get: () => row };
    const projected = overlayShellJobFacts(message, "s", store);
    expect(projected.parts[0]).toMatchObject({
      result: {
        output: "old",
        details: {
          mode: "background",
          status: "cancelled",
          stopReason: "user",
          cleanup: "confirmed",
        },
      },
    });
    expect(message.parts[0]).toMatchObject({
      result: { details: { status: "running" } },
    });
    for (const patch of [
      { sessionId: "other" },
      { rootSessionId: "other" },
      { contextScopeId: "child" },
      { messageId: "other" },
      { callId: "other" },
    ]) {
      expect(
        overlayShellJobFacts(message, "s", {
          get: () => ({ ...row, ...patch }),
        }),
      ).toEqual(message);
    }
    expect(overlayShellJobFacts(message, "s", { get: () => null })).toEqual(
      message,
    );
  });
  it("matches a child session and scope only under its trusted root", () => {
    const message: UiMessage = {
      id: "message",
      role: "assistant",
      createdAt: new Date(0).toISOString(),
      parts: [
        {
          type: "tool-result",
          id: "part",
          result: {
            callId: "call",
            output: "saved",
            outputAvailable: true,
            details: { kind: "bash", jobId: "job", status: "running" },
          },
        },
      ],
    };
    const row = shellJobFixture({
      sessionId: "child",
      rootSessionId: "root",
      contextScopeId: "scope",
      messageId: "message",
      callId: "call",
      status: "completed",
    });
    const store = { get: () => row };
    expect(
      overlayShellJobFacts(message, "child", store, {
        rootSessionId: "root",
        contextScopeId: "scope",
      }).parts[0],
    ).toMatchObject({ result: { details: { status: "completed" } } });
    expect(
      overlayShellJobFacts(message, "child", store, {
        rootSessionId: "other",
        contextScopeId: "scope",
      }),
    ).toEqual(message);
    expect(
      overlayShellJobFacts(message, "child", store, {
        rootSessionId: "root",
        contextScopeId: "other",
      }),
    ).toEqual(message);
  });
});
