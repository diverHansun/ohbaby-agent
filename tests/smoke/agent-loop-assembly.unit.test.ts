import { describe, expect, it } from "vitest";
import {
  fingerprint,
  matchAssembly,
  requestShape,
  opaqueFingerprints,
  type AssemblyRecord,
} from "./agent-loop-assembly.js";
import { summarizeWire, publicWire } from "./agent-loop-observer.js";
import type { PreparedModelRequest } from "../../packages/ohbaby-agent/src/core/context/index.js";

const request: PreparedModelRequest = {
  messages: [
    { role: "user", content: "private prompt" },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { callId: "c1", name: "read", argumentsJson: '{"path":"fixture"}' },
      ],
    },
    { role: "tool", callId: "c1", content: "private result" },
  ],
  tools: [{ name: "read", inputSchema: { type: "object" } }],
};
describe("real lifecycle assembly observation", () => {
  it("compares the latest same-scope prepared payload and rejects stale or changed data", () => {
    const record = {
      sequence: 1,
      sessionId: "s",
      shape: requestShape(request),
    } as AssemblyRecord;
    expect(
      matchAssembly([record], { ...request, sessionId: "s" }).matchesPrepared,
    ).toBe(true);
    expect(
      matchAssembly([record], { ...request, sessionId: "s", tools: [] })
        .matchesPrepared,
    ).toBe(false);
    expect(
      matchAssembly([record], {
        ...request,
        sessionId: "s",
        contextScopeId: "child",
      }).matchesPrepared,
    ).toBe(false);
    expect(
      matchAssembly(
        [
          record,
          {
            ...record,
            sequence: 2,
            shape: requestShape({ ...request, tools: [] }),
          },
        ],
        { ...request, sessionId: "s" },
      ).matchesPrepared,
    ).toBe(false);
    expect(JSON.stringify(record)).not.toContain("private");
  });
  it.each([
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c1",
              function: { name: "read", arguments: '{"path":"fixture"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "private result" },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
    },
    {
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "read",
          arguments: '{"path":"fixture"}',
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: "private result",
        },
      ],
      tools: [{ type: "function", name: "read" }],
    },
    {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "read",
              input: { path: "fixture" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: "private result",
            },
          ],
        },
      ],
      tools: [{ name: "read" }],
    },
  ])(
    "compares real protocol tool arguments/results without storing their text",
    (body) => {
      const wire = summarizeWire(body);
      const shape = requestShape(request);
      expect(wire.tools).toEqual(shape.tools);
      expect(wire.callPayloads).toEqual(shape.calls);
      expect(wire.resultPayloads).toEqual(shape.results);
      expect(JSON.stringify(publicWire(wire))).not.toContain("private result");
      expect(JSON.stringify(publicWire(wire))).not.toContain("fixture");
      const changed = summarizeWire({
        input: [
          { type: "function_call_output", call_id: "c1", output: "different" },
        ],
      });
      expect(changed.resultPayloads).not.toEqual(shape.results);
    },
  );
  it("compares Chat native reasoning with its wire field names", () => {
    const details = [{ type: "reasoning.encrypted", data: "OPAQUE_CHAT" }];
    expect(
      opaqueFingerprints({
        protocol: "openai-compatible",
        reasoningText: "PRIVATE_REASONING",
        reasoningDetails: details,
      }),
    ).toEqual(
      opaqueFingerprints({
        role: "assistant",
        reasoning_content: "PRIVATE_REASONING",
        reasoning_details: details,
      }),
    );
    expect(
      JSON.stringify(opaqueFingerprints({ reasoning_details: details })),
    ).not.toContain("OPAQUE_CHAT");
  });
  it("fingerprints protocol replay values without exporting opaque content", () => {
    const values = [
      { type: "reasoning", encrypted_content: "OPAQUE1" },
      { type: "thinking", signature: "OPAQUE2" },
      { type: "redacted_thinking", data: "OPAQUE3" },
    ];
    expect(opaqueFingerprints(values)).toEqual(
      ["OPAQUE1", "OPAQUE2", "OPAQUE3"].map(fingerprint),
    );
    expect(opaqueFingerprints([{ type: "text", data: "ordinary" }])).toEqual(
      [],
    );
    expect(JSON.stringify(opaqueFingerprints(values))).not.toContain("OPAQUE");
  });
});
