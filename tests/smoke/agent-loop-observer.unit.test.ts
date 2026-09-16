import { describe, expect, it } from "vitest";
import {
  publicWire,
  summarizeWire,
  safeLoopError,
  toolHandoffChecks,
  type LoopRequest,
} from "./agent-loop-observer.js";

describe("real-loop observation integrity", () => {
  it.each([
    {
      messages: [
        {
          role: "assistant",
          content: "fixture",
          tool_calls: [{ id: "call-7", function: { name: "read" } }],
        },
        { role: "tool", tool_call_id: "call-7", content: "result" },
      ],
    },
    {
      input: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "fixture" }],
        },
        { type: "function_call", call_id: "call-7" },
        { type: "function_call_output", call_id: "call-7", output: "result" },
      ],
    },
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "fixture" },
            { type: "tool_use", id: "call-7" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-7", content: "result" },
          ],
        },
      ],
    },
  ])("extracts actual protocol tool IDs and visible assistant text", (body) => {
    const wire = summarizeWire(body);
    expect(wire.calls).toEqual(["call-7"]);
    expect(wire.results).toEqual(["call-7"]);
    expect(wire.assistantText).toBe("fixture");
    expect(JSON.stringify(publicWire(wire))).not.toContain("fixture");
    const request: LoopRequest = {
      sequence: 1,
      purpose: "agent-step",
      exhausted: true,
      nativeCount: 0,
      finishes: ["stop"],
      outputCharacters: 7,
      http: [wire],
    };
    const events = [
      { type: "tool:start", callId: "call-7" },
      { type: "tool:result", callId: "call-7", success: true },
    ];
    expect(toolHandoffChecks({ requests: [request], events })).toEqual({
      agentStepWireCount: 1,
      startedCalls: 1,
      allExecuted: true,
      allReplayed: true,
      allResultsPaired: true,
    });
    expect(
      toolHandoffChecks({ requests: [{ ...request, http: [] }], events })
        .allReplayed,
    ).toBe(false);
    expect(
      toolHandoffChecks({ requests: [request], events: events.slice(0, 1) })
        .allExecuted,
    ).toBe(false);
    expect(
      toolHandoffChecks({
        requests: [request],
        events: events.map((event) => ({ ...event, callId: "other-call" })),
      }).allReplayed,
    ).toBe(false);
  });
  it("retains diagnostic classes without leaking upstream text or nested payloads", () => {
    const error = Object.assign(new Error("private provider payload"), {
      code: "ECONNRESET",
      status: 502,
      cause: new TypeError("secret nested body"),
    });
    const safe = safeLoopError(error);
    expect(safe.name).toBe("Error");
    expect(safe.code).toBe("ECONNRESET");
    expect(safe.status).toBe(502);
    expect(safe.cause?.name).toBe("TypeError");
    class APIError extends Error {
      readonly error = { type: "overloaded_error", message: "do not retain" };
    }
    const sdkError = new APIError("private provider body");
    sdkError.stack =
      "Error\n at iterator (/node_modules/@anthropic-ai/sdk/core/streaming.mjs:113:31)";
    const sdkSafe = safeLoopError(sdkError);
    expect(sdkSafe.constructorName).toBe("APIError");
    expect(sdkSafe.origin).toBe("anthropic-sdk-stream");
    expect(sdkSafe.providerErrorType).toBe("overloaded_error");
    expect(JSON.stringify(sdkSafe)).not.toMatch(
      /private provider body|do not retain|node_modules/,
    );

    expect(JSON.stringify(safe)).not.toMatch(
      /private provider payload|secret nested body/,
    );
    expect(
      safeLoopError(new Error("Incomplete Anthropic message stream."))
        .knownProtocolError,
    ).toBe("Incomplete Anthropic message stream.");
  });
  it("rejects vacuous observations and never exports native content", () => {
    expect(toolHandoffChecks({ requests: [], events: [] })).toEqual({
      agentStepWireCount: 0,
      startedCalls: 0,
      allExecuted: false,
      allReplayed: false,
      allResultsPaired: false,
    });
    const wire = summarizeWire({
      input: [
        { type: "reasoning", encrypted_content: "OPAQUE_PAYLOAD" },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "VISIBLE_BODY" }],
        },
      ],
    });
    expect(wire.nativeTypes).toEqual(["reasoning"]);
    expect(JSON.stringify(publicWire(wire))).not.toMatch(
      /OPAQUE_PAYLOAD|VISIBLE_BODY/,
    );
  });
});
