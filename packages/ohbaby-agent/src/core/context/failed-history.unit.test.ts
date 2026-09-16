import { describe, expect, it } from "vitest";
import type {
  MessageError,
  MessageWithParts,
  ModelStatePart,
  Part,
  TextPart,
  ToolPart,
} from "../message/types.js";
import { serializeHistory } from "./serialization.js";
import { serializeHistoryMessages } from "./serializer.js";
import { estimateContextOccupancyComposition } from "./token-estimation.js";
import type { AssembledContext } from "./types.js";

const summaryOptions = {
  includeModelContext: false,
  includeToolContext: true,
};
const base = {
  id: "part",
  messageId: "assistant",
  sessionId: "session",
  orderIndex: 0,
};

function text(value: string, patch: Partial<TextPart> = {}): TextPart {
  return { ...base, type: "text", text: value, ...patch };
}

function fact(value = "[Response cancelled by the user.]"): TextPart {
  return text(value, {
    id: "interruption",
    synthetic: true,
    metadata: { kind: "lifecycle-interruption" },
  });
}

function assistant(
  parts: readonly Part[],
  error?: MessageError,
): MessageWithParts {
  return {
    info: {
      id: "assistant",
      sessionId: "session",
      agent: "test",
      role: "assistant",
      finish: error === undefined ? "stop" : "error",
      time: { created: 1, completed: 2 },
      ...(error === undefined ? {} : { error }),
    },
    parts,
  };
}

function tool(): ToolPart {
  return {
    ...base,
    id: "tool",
    type: "tool",
    callId: "call_read",
    tool: "read",
    state: {
      status: "completed",
      input: { path: "a.txt" },
      output: "saved result",
    },
  };
}

function native(): ModelStatePart {
  return {
    ...base,
    id: "native",
    type: "model-state",
    modelState: {
      version: 1,
      origin: {
        provider: "fixture",
        model: "fixture",
        protocol: "anthropic",
        endpoint: "https://fixture.invalid",
      },
      output: {
        protocol: "anthropic",
        items: [
          { type: "text", text: "accepted body" },
          {
            type: "tool_use",
            id: "call_read",
            name: "read",
            input: { path: "a.txt" },
          },
        ],
      },
      estimate: { tokens: 20, source: "output" },
    },
  };
}

describe("failed history shared by requests and summary material", () => {
  it.each([
    {
      name: "MessageOutputLengthError",
      marker: "[Response incomplete: output limit reached.]",
    },
    {
      name: "MessageContentFilterError",
      marker: "[Response incomplete: content was filtered.]",
    },
    {
      name: "MessageStreamInterruptedError",
      marker: "[Response interrupted: the saved text below may be incomplete.]",
    },
  ] as const)(
    "projects only saved visible text for $name",
    ({ name, marker }) => {
      const history = [
        assistant(
          [
            text("first "),
            text("hidden", { ignored: true }),
            text("retired", { time: { compacted: 3 } }),
            text("generated", { synthetic: true }),
            text("runtime", {
              synthetic: true,
              metadata: { kind: "model-context:runtime:v1" },
            }),
            {
              ...base,
              id: "reasoning",
              type: "reasoning",
              text: "private reasoning",
            },
            text("second"),
            tool(),
            native(),
          ],
          { name },
        ),
      ];
      const before = structuredClone(history);
      const expected = `${marker}\nfirst second`;

      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: expected },
      ]);
      expect(serializeHistory(history, summaryOptions)).toBe(
        `assistant: ${expected}`,
      );
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: expected },
      ]);
      expect(history).toEqual(before);
    },
  );

  it.each([
    {
      name: "MessageOutputLengthError",
      marker: "[Response incomplete: output limit reached.]",
    },
    {
      name: "MessageContentFilterError",
      marker: "[Response incomplete: content was filtered.]",
    },
    {
      name: "MessageStreamInterruptedError",
      marker: "[Response interrupted: the saved text below may be incomplete.]",
    },
  ] as const)(
    "requires an active durable fact for bodyless $name",
    ({ name, marker }) => {
      const history = [assistant([fact(marker), native()], { name })];
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: marker },
      ]);
      expect(serializeHistory(history, summaryOptions)).toBe(
        `assistant: ${marker}`,
      );
      expect(
        serializeHistoryMessages([assistant([native()], { name })]),
      ).toEqual([]);
      expect(
        serializeHistory([assistant([native()], { name })], summaryOptions),
      ).toBe("");
    },
  );

  it("sends cancellation fact without the cancelled body or tool parameters", () => {
    const history = [
      assistant([text("cancelled body"), tool(), native(), fact()], {
        name: "MessageAbortedError",
        message: "internal cancellation detail",
      }),
    ];
    expect(serializeHistoryMessages(history)).toEqual([
      { role: "assistant", content: "[Response cancelled by the user.]" },
    ]);
    expect(serializeHistory(history, summaryOptions)).toBe(
      "assistant: [Response cancelled by the user.]",
    );
  });

  it.each([
    { name: "Unknown", message: "transport interrupted output limit reached" },
    { name: "APIError", message: "cancelled", isRetryable: true },
  ] as const)(
    "does not infer replay permission from $name wording",
    (error) => {
      const history = [
        assistant([text("untrusted body"), tool(), fact()], error),
      ];
      expect(serializeHistoryMessages(history)).toEqual([]);
      expect(serializeHistory(history, summaryOptions)).toBe("");
    },
  );

  it.each([
    [],
    [text("retired body", { time: { compacted: 3 } })],
    [{ ...fact(), time: { compacted: 3 } }],
    [{ ...fact(), ignored: true }],
  ])(
    "never regenerates a marker from an error after its carrier leaves active history (%#)",
    (...parts) => {
      for (const error of [
        { name: "MessageOutputLengthError" },
        { name: "MessageAbortedError", message: "cancelled" },
      ] as const) {
        const history = [assistant(parts, error)];
        expect(serializeHistoryMessages(history)).toEqual([]);
        expect(serializeHistory(history, summaryOptions)).toBe("");
      }
    },
  );

  it("keeps readable compaction scoring unchanged while summary input excludes cancelled text", () => {
    const history = [
      assistant([text("cancelled body"), fact()], {
        name: "MessageAbortedError",
        message: "cancelled",
      }),
    ];
    expect(serializeHistory(history)).toBe(
      "assistant: cancelled body\n[Response cancelled by the user.]",
    );
    expect(serializeHistory(history, summaryOptions)).toBe(
      "assistant: [Response cancelled by the user.]",
    );
  });

  it("places an accepted native roundtrip's cancellation notice after its paired results", () => {
    const nativePart = native();
    const history = [
      assistant([text("accepted body"), tool(), nativePart, fact()]),
    ];
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content: "accepted body",
        toolCalls: [
          {
            callId: "call_read",
            name: "read",
            argumentsJson: '{"path":"a.txt"}',
          },
        ],
        modelState: nativePart.modelState,
      },
      { role: "tool", callId: "call_read", content: "saved result" },
      { role: "assistant", content: "[Response cancelled by the user.]" },
    ]);
    expect(serializeHistory(history, summaryOptions)).toBe(
      'assistant: accepted body\n{"tool":"read","callId":"call_read","input":{"path":"a.txt"},"status":"completed"}\nsaved result\n[Response cancelled by the user.]',
    );
  });

  it("keeps accepted tool results when a cancellation notice is retired", () => {
    const history = [
      assistant([tool(), { ...fact(), time: { compacted: 3 } }]),
    ];
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            callId: "call_read",
            name: "read",
            argumentsJson: '{"path":"a.txt"}',
          },
        ],
      },
      { role: "tool", callId: "call_read", content: "saved result" },
    ]);
    expect(serializeHistory(history, summaryOptions)).not.toContain(
      "cancelled",
    );
  });

  it("attributes each failed projection once to conversation despite runtime and subagent parts", () => {
    const history = [
      assistant(
        [
          text("saved body"),
          text("runtime", {
            synthetic: true,
            metadata: { kind: "model-context:runtime:v1" },
          }),
          { ...tool(), tool: "subagent_run" },
        ],
        { name: "MessageOutputLengthError" },
      ),
    ];
    const context: AssembledContext = {
      assembledAt: 3,
      hasSummary: false,
      history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      sessionId: "session",
      systemPrompt: "",
    };
    const payloads: string[] = [];
    const result = estimateContextOccupancyComposition(
      {
        context,
        request: {
          tools: undefined,
          messages: [
            {
              role: "assistant",
              content:
                "[Response incomplete: output limit reached.]\nsaved body",
            },
          ],
        },
      },
      {
        estimateTokens: (value) => {
          payloads.push(value);
          return 1;
        },
      },
    );
    expect(result).toEqual({
      "system-prompt": 0,
      "builtin-tools": 0,
      mcp: 0,
      skills: 0,
      conversation: 1,
      "summarized-conversation": 0,
      "subagent-exchanges": 0,
    });
    expect(payloads).toEqual([
      JSON.stringify({
        role: "assistant",
        content: "[Response incomplete: output limit reached.]\nsaved body",
      }),
    ]);
  });
});
