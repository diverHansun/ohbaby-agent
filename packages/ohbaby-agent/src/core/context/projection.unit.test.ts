import { describe, expect, it } from "vitest";
import type { MessageWithParts } from "../message/index.js";
import type { ContextUsage } from "./types.js";
import { createMaskConfig, reduceForModel } from "./projection.js";
import { serializeForLlm } from "./serializer.js";

const USAGE: ContextUsage = {
  contextLimit: 1_000,
  currentTokens: 700,
  modelId: "model-a",
  remainingTokens: 300,
  usageRatio: 0.7,
};

const TOKEN_COUNTER = {
  estimateTokens(content: string): number {
    return content.length;
  },
};

function userMessage(id: string, text: string): MessageWithParts {
  return {
    info: {
      agent: "test",
      id,
      role: "user",
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${id}`,
        messageId: id,
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

function assistantToolMessage(input: {
  readonly created?: number;
  readonly id: string;
  readonly tool: string;
  readonly output: string;
}): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: input.id,
      role: "assistant",
      sessionId: "session_1",
      time: { created: input.created ?? 1 },
    },
    parts: [
      {
        callId: `call_${input.id}`,
        id: `part_${input.id}`,
        messageId: input.id,
        orderIndex: 0,
        sessionId: "session_1",
        state: {
          input: { path: `${input.id}.txt` },
          output: input.output,
          status: "completed",
        },
        tool: input.tool,
        type: "tool",
      },
    ],
  };
}

function assistantErrorToolMessage(input: {
  readonly id: string;
  readonly tool: string;
  readonly error: string;
}): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: input.id,
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        callId: `call_${input.id}`,
        id: `part_${input.id}`,
        messageId: input.id,
        orderIndex: 0,
        sessionId: "session_1",
        state: {
          error: input.error,
          input: { path: `${input.id}.txt` },
          status: "error",
        },
        tool: input.tool,
        type: "tool",
      },
    ],
  };
}

function assistantAbortedToolMessage(input: {
  readonly id: string;
  readonly tool: string;
  readonly output?: string;
}): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: input.id,
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        callId: `call_${input.id}`,
        id: `part_${input.id}`,
        messageId: input.id,
        orderIndex: 0,
        sessionId: "session_1",
        state: {
          error: "Tool execution aborted by user",
          input: { path: `${input.id}.txt` },
          output: input.output,
          status: "aborted",
        },
        tool: input.tool,
        type: "tool",
      },
    ],
  };
}

function textAssistantMessage(id: string, text: string): MessageWithParts {
  return {
    info: {
      agent: "test",
      id,
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${id}`,
        messageId: id,
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

describe("reduceForModel", () => {
  it("dark ships masking by reporting candidates without changing history", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: false,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(result.history).toBe(history);
    expect(result.event).toMatchObject({
      enabled: false,
      maskedPartIds: ["part_old_read"],
      maskedTokens: 80,
      sessionId: "session_1",
    });
  });

  it("replaces old tool output with a size-aware placeholder when enabled", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });
    const messages = serializeForLlm({
      history: result.history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages).toEqual([
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"path":"old_read.txt"}',
              name: "read_file",
            },
            id: "call_old_read",
            type: "function",
          },
        ],
      },
      {
        content: "[Old tool result cleared (was ~80 tokens)]",
        role: "tool",
        tool_call_id: "call_old_read",
      },
      { content: "new request", role: "user" },
    ]);
  });

  it("does not mask exempt tools, small outputs, text parts, or the latest turn", () => {
    const history = [
      assistantToolMessage({
        id: "old_edit",
        output: "e".repeat(80),
        tool: "edit_file",
      }),
      assistantToolMessage({
        id: "old_small",
        output: "small",
        tool: "unknown_tool",
      }),
      textAssistantMessage("old_text", "t".repeat(80)),
      userMessage("latest_user", "new request"),
      assistantToolMessage({
        id: "latest_read",
        output: "r".repeat(80),
        tool: "read_file",
      }),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 10,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(result.event).toMatchObject({
      maskedPartIds: [],
      skippedReason: "all-exempt",
    });
    expect(result.history).toBe(history);
  });

  it("does not mask the first candidate before the first cutoff advance", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.9,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: { ...USAGE, usageRatio: 0.1 },
    });

    expect(result.event).toMatchObject({
      cutoff: 0,
      maskedPartIds: [],
      skippedReason: "below-threshold",
    });
    expect(result.history).toBe(history);
  });

  it("keeps an existing cutoff applied even when the current usage is below threshold", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.9,
        protectionTokens: 1,
      }),
      cutoff: 1,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: { ...USAGE, usageRatio: 0.1 },
    });

    expect(result.event.maskedPartIds).toEqual(["part_old_read"]);
    expect(serializeForLlm({
      history: result.history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    })[1]).toMatchObject({
      content: "[Old tool result cleared (was ~80 tokens)]",
      role: "tool",
      tool_call_id: "call_old_read",
    });
  });

  it("masks error output but does not treat abort status text as prunable content", () => {
    const errorMessage = assistantErrorToolMessage({
      error: "x".repeat(80),
      id: "old_error",
      tool: "read_file",
    });
    const abortedWithoutOutput = assistantAbortedToolMessage({
      id: "old_abort",
      tool: "read_file",
    });
    const history = [
      errorMessage,
      abortedWithoutOutput,
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(result.event.maskedPartIds).toEqual(["part_old_error"]);
    expect(serializeForLlm({
      history: result.history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    })).toEqual([
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"path":"old_error.txt"}',
              name: "read_file",
            },
            id: "call_old_error",
            type: "function",
          },
        ],
      },
      {
        content: "[Old tool result cleared (was ~80 tokens)]",
        role: "tool",
        tool_call_id: "call_old_error",
      },
      {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"path":"old_abort.txt"}',
              name: "read_file",
            },
            id: "call_old_abort",
            type: "function",
          },
        ],
      },
      {
        content: "Tool execution aborted by user",
        role: "tool",
        tool_call_id: "call_old_abort",
      },
      { content: "new request", role: "user" },
    ]);
  });

  it("reports below-batch when candidates are real but too small as a group", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 100,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(result.event).toMatchObject({
      maskedPartIds: [],
      skippedReason: "below-batch",
    });
    expect(result.history).toBe(history);
  });

  it("protects the tail token window before considering old tool output", () => {
    const history = [
      assistantToolMessage({
        id: "old_read",
        output: "x".repeat(80),
        tool: "read_file",
      }),
      userMessage("latest_user", "new request"),
    ];

    const result = reduceForModel({
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 10_000,
      }),
      cutoff: 0,
      history,
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(result.event).toMatchObject({
      maskedPartIds: [],
      skippedReason: "all-exempt",
    });
    expect(result.history).toBe(history);
  });

  it("advances cutoff monotonically across repeated reductions", () => {
    const first = reduceForModel({
      config: createMaskConfig({
        enabled: false,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history: [
        assistantToolMessage({
          created: 10,
          id: "old_read_a",
          output: "a".repeat(80),
          tool: "read_file",
        }),
        userMessage("latest_user_a", "new request"),
      ],
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });
    const second = reduceForModel({
      config: createMaskConfig({
        enabled: false,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: first.cutoff,
      history: [
        assistantToolMessage({
          created: 10,
          id: "old_read_a",
          output: "a".repeat(80),
          tool: "read_file",
        }),
        assistantToolMessage({
          created: 20,
          id: "old_read_b",
          output: "b".repeat(80),
          tool: "read_file",
        }),
        userMessage("latest_user_b", "new request"),
      ],
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });

    expect(first.cutoff).toBe(10);
    expect(second.cutoff).toBe(20);
    expect(second.cutoff).toBeGreaterThanOrEqual(first.cutoff);
  });

  it("does not let an existing cutoff drift onto newer messages after older messages disappear", () => {
    const first = reduceForModel({
      config: createMaskConfig({
        enabled: false,
        minPartTokens: 1,
        minPrunableTokens: 1,
        protectionTokens: 1,
      }),
      cutoff: 0,
      history: [
        assistantToolMessage({
          created: 10,
          id: "old_read_a",
          output: "a".repeat(80),
          tool: "read_file",
        }),
        userMessage("latest_user_a", "new request"),
      ],
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: USAGE,
    });
    const afterOldMessageRemoved = reduceForModel({
      config: createMaskConfig({
        enabled: false,
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.9,
        protectionTokens: 1,
      }),
      cutoff: first.cutoff,
      history: [
        assistantToolMessage({
          created: 20,
          id: "newer_read_b",
          output: "b".repeat(80),
          tool: "read_file",
        }),
        userMessage("latest_user_b", "new request"),
      ],
      sessionId: "session_1",
      tokenCounter: TOKEN_COUNTER,
      usage: { ...USAGE, usageRatio: 0.1 },
    });

    expect(first.event.maskedPartIds).toEqual(["part_old_read_a"]);
    expect(afterOldMessageRemoved.event.maskedPartIds).toEqual([]);
  });
});
