import { describe, expect, it } from "vitest";
import {
  MODEL_CONTEXT_RUNTIME_KIND,
  type MessageWithParts,
  type Part,
} from "../message/index.js";
import type { ToolDefinition } from "../tool-scheduler/index.js";
import type {
  AssembledContext,
  PreparedModelRequest,
  TokenCounter,
} from "./types.js";
import {
  estimateContextOccupancyComposition,
  estimatePreparedRequestHeuristic,
} from "./token-estimation.js";
import { serializeForLlm } from "./serializer.js";
import { toModelTools } from "../agents/runner.js";
import { estimateTokensForText } from "../../services/llm-model/tokenCounting.js";

it("records canonical totals and all seven buckets after retiring Chat measurement", () => {
  const baselineTool = (id: string, name: string): Part =>
    ({
      ...toolPart(id, name),
      state: {
        status: "completed",
        input: { q: "你好" },
        output: `${name} result`,
      },
    }) as Part;
  const history = [
    message("s", "assistant", [
      textPart("s", "earlier summary", {
        metadataKind: "context-summary",
        synthetic: true,
      }),
    ]),
    message("u", "user", [
      textPart("u", "你好 question"),
      textPart("u", "runtime context", {
        metadataKind: MODEL_CONTEXT_RUNTIME_KIND,
        synthetic: true,
      }),
    ]),
    message("a", "assistant", [
      textPart("a", "delegating"),
      baselineTool("a", "subagent_run"),
    ]),
    message("b", "assistant", [baselineTool("b", "read")]),
  ];
  const definitions = [
    definition("subagent_run", "builtin"),
    definition("read", "module"),
    definition("mcp_search", "mcp"),
    definition("skill", "skill"),
  ].map((item) => ({
    ...item,
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  }));
  const context = {
    ...assembledContext(history),
    memory: { global: "", project: "", merged: "memory note" },
    systemPrompt: "system instruction",
  };
  const tailDirectives = [
    { role: "system" as const, content: "finish carefully" },
  ];
  const activeReasoningByMessageId = new Map([["b", "思考 next"]]);
  const request = matchingRequest(
    context,
    toModelTools(definitions),
    tailDirectives,
    activeReasoningByMessageId,
  );
  const input = {
    context,
    request,
    tailDirectives,
    activeReasoningByMessageId,
    toolDefinitions: definitions,
  };
  // Removing four nested tool envelopes, two call envelopes/IDs and the old
  // reasoning key removes 184 ASCII characters: 1453 → 1269, 372 → 326 tokens.
  expect(estimatePreparedRequestHeuristic(request, characterCounter())).toBe(
    1269,
  );
  expect(
    estimateContextOccupancyComposition(input, characterCounter()),
  ).toEqual({
    "system-prompt": 175,
    "builtin-tools": 287,
    mcp: 148,
    skills: 138,
    conversation: 292,
    "summarized-conversation": 82,
    "subagent-exchanges": 212,
  });
  expect(
    estimatePreparedRequestHeuristic(request, {
      estimateTokens: estimateTokensForText,
    }),
  ).toBe(326);
  expect(
    estimateContextOccupancyComposition(input, {
      estimateTokens: estimateTokensForText,
    }),
  ).toEqual({
    "system-prompt": 44,
    "builtin-tools": 72,
    mcp: 37,
    skills: 35,
    conversation: 80,
    "summarized-conversation": 21,
    "subagent-exchanges": 56,
  });
});

it("measures the project's flat message and tool contract without a Chat conversion", () => {
  const material: string[] = [];
  const request: PreparedModelRequest = {
    messages: [
      {
        role: "assistant",
        content: null,
        reasoningText: "consider",
        toolCalls: [
          {
            callId: "call-1",
            name: "lookup",
            argumentsJson: '{ "q": "你好" }',
          },
        ],
      },
      { role: "tool", callId: "call-1", content: "found" },
    ],
    tools: [
      {
        name: "lookup",
        description: "Find data",
        inputSchema: { type: "object" },
      },
    ],
  };
  estimatePreparedRequestHeuristic(request, {
    estimateTokens: (text) => {
      material.push(text);
      return text.length;
    },
  });
  expect(material).toHaveLength(1);
  expect(
    material[0]?.split("\n").map((line): unknown => JSON.parse(line)),
  ).toEqual([
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { callId: "call-1", name: "lookup", argumentsJson: '{ "q": "你好" }' },
      ],
      reasoningText: "consider",
    },
    { role: "tool", callId: "call-1", content: "found" },
    [
      {
        name: "lookup",
        description: "Find data",
        inputSchema: { type: "object" },
      },
    ],
  ]);
});

function characterCounter(): Pick<TokenCounter, "estimateTokens"> {
  return {
    estimateTokens: (content: string): number => content.length,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function assembledContext(
  history: readonly MessageWithParts[],
): AssembledContext {
  return {
    assembledAt: 1_000,
    hasSummary: history.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "text" && part.metadata?.kind === "context-summary",
      ),
    ),
    history,
    isSubagent: false,
    memory: { global: "", merged: "remember this", project: "" },
    sessionId: "session_1",
    systemPrompt: "system instructions",
  };
}

function message(
  id: string,
  role: "assistant" | "system" | "user",
  parts: readonly Part[],
): MessageWithParts {
  const info: MessageWithParts["info"] =
    role === "system"
      ? {
          id,
          kind: "info",
          role,
          sessionId: "session_1",
          time: { created: 1_000 },
        }
      : {
          agent: "test",
          id,
          role,
          sessionId: "session_1",
          time: { created: 1_000 },
        };
  return {
    info,
    parts,
  };
}

function textPart(
  messageId: string,
  text: string,
  input: {
    readonly metadataKind?: string;
    readonly synthetic?: boolean;
  } = {},
): Part {
  return {
    id: `${messageId}_text_${text}`,
    messageId,
    ...(input.metadataKind === undefined
      ? {}
      : { metadata: { kind: input.metadataKind } }),
    orderIndex: 0,
    sessionId: "session_1",
    ...(input.synthetic === undefined ? {} : { synthetic: input.synthetic }),
    text,
    type: "text",
  };
}

function toolPart(messageId: string, tool: string): Part {
  return {
    callId: `call_${tool}`,
    id: `${messageId}_${tool}`,
    messageId,
    orderIndex: 1,
    sessionId: "session_1",
    state: {
      input: { prompt: "do work" },
      output: `${tool} output`,
      status: "completed",
    },
    tool,
    type: "tool",
  };
}

function definition(
  name: string,
  source: ToolDefinition["source"],
): ToolDefinition {
  return {
    category: source === "skill" ? "skill" : "readonly",
    description: `${name} description`,
    name,
    parameters: { type: "object" },
    source,
  };
}

function requestTool(
  name: string,
): NonNullable<PreparedModelRequest["tools"]>[number] {
  return {
    description: `${name} description`,
    name,
    inputSchema: { type: "object" },
  };
}

function matchingRequest(
  context: AssembledContext,
  tools: PreparedModelRequest["tools"] = [],
  tailDirectives: PreparedModelRequest["messages"] = [],
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
): PreparedModelRequest {
  return {
    messages: [
      ...serializeForLlm({
        activeReasoningByMessageId,
        history: context.history,
        isSubagent: context.isSubagent,
        memory: context.memory,
        systemPrompt: context.systemPrompt,
      }),
      ...tailDirectives,
    ],
    tools,
  };
}

describe("estimatePreparedRequestHeuristic", () => {
  it("preserves canonical keys, empty values, raw schema, and argument text", () => {
    const request = deepFreeze({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              cacheControl: { type: "ephemeral", ttl: "5m" },
              text: "",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              callId: "c",
              name: "read",
              argumentsJson: '{ "cacheControl": "literal" }',
            },
          ],
          reasoningText: "",
          name: "speaker",
          refusal: null,
          audio: null,
        },
        { role: "tool", callId: "c", content: [] },
      ],
      tools: [
        {
          name: "read",
          inputSchema: {
            type: "object",
            properties: { cacheControl: { type: "string" } },
            required: [],
          },
        },
      ],
    } satisfies PreparedModelRequest);
    const before = structuredClone(request);
    let material = "";
    estimatePreparedRequestHeuristic(request, {
      estimateTokens(text) {
        material = text;
        return text.length;
      },
    });
    expect(
      material.split("\n").map((line): unknown => JSON.parse(line)),
    ).toEqual([...request.messages, request.tools]);
    expect(request).toEqual(before);
  });
  it("counts the complete message projection without mutating the request", () => {
    const request = deepFreeze({
      messages: [
        { role: "system" as const, content: "system prompt" },
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "answer" },
      ],
      tools: undefined,
    } satisfies PreparedModelRequest);
    const before = structuredClone(request);

    expect(estimatePreparedRequestHeuristic(request, characterCounter())).toBe(
      request.messages.map((message) => JSON.stringify(message)).join("\n")
        .length,
    );
    expect(request).toEqual(before);
  });

  it("counts non-empty tool schemas in their request order", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools = [
      {
        description: "Read a file",
        name: "read_file",
        inputSchema: { type: "object" },
      },
      {
        description: "List files",
        name: "list_files",
        inputSchema: { type: "object" },
      },
    ];
    const counter = characterCounter();
    const messagesOnly = estimatePreparedRequestHeuristic(
      { messages, tools: undefined },
      counter,
    );

    expect(
      estimatePreparedRequestHeuristic({ messages, tools: [] }, counter),
    ).toBe(messagesOnly);
    expect(estimatePreparedRequestHeuristic({ messages, tools }, counter)).toBe(
      197,
    );
  });

  it("counts assistant tool calls when message content is null", () => {
    const request = {
      messages: [
        {
          content: null,
          role: "assistant" as const,
          toolCalls: [
            {
              callId: "call_read",
              argumentsJson: '{"path":"/a/very/long/path.ts"}',
              name: "read_file",
            },
          ],
        },
      ],
      tools: undefined,
    } satisfies PreparedModelRequest;

    expect(estimatePreparedRequestHeuristic(request, characterCounter())).toBe(
      145,
    );
  });
});

describe("estimateContextOccupancyComposition", () => {
  it("matches canonical measurement fields despite message key insertion order", () => {
    const context = assembledContext([
      message("u", "user", [textPart("u", "hello")]),
    ]);
    const request = matchingRequest(context);
    const reordered: PreparedModelRequest = {
      ...request,
      messages: request.messages.map((item) => ({
        content: item.content,
        role: item.role,
      })) as PreparedModelRequest["messages"],
    };
    expect(
      estimateContextOccupancyComposition(
        { context, request: reordered },
        characterCounter(),
      ),
    ).toEqual(
      estimateContextOccupancyComposition(
        { context, request },
        characterCounter(),
      ),
    );
    expect(
      estimateContextOccupancyComposition(
        {
          context,
          request: { ...request, messages: [...request.messages].reverse() },
        },
        characterCounter(),
      ),
    ).toBeUndefined();
  });
  it("reports system, builtin tools, and conversation for a basic request", () => {
    const history = [message("user_1", "user", [textPart("user_1", "hello")])];
    const context = assembledContext(history);
    const definitions = [definition("read_file", "builtin")];
    const tools = [requestTool("read_file")];

    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context, tools),
        toolDefinitions: definitions,
      },
      characterCounter(),
    );

    expect(composition).toMatchObject({
      mcp: 0,
      skills: 0,
      "subagent-exchanges": 0,
      "summarized-conversation": 0,
    });
    expect(composition?.["system-prompt"]).toBeGreaterThan(0);
    expect(composition?.["builtin-tools"]).toBeGreaterThan(0);
    expect(composition?.conversation).toBeGreaterThan(0);
  });

  it("classifies all seven buckets using persisted part and tool provenance", () => {
    const history = [
      message("summary_1", "assistant", [
        textPart("summary_1", "earlier work", {
          metadataKind: "context-summary",
          synthetic: true,
        }),
      ]),
      message("user_1", "user", [
        textPart("user_1", "normal question"),
        textPart("user_1", "runtime model context", {
          metadataKind: MODEL_CONTEXT_RUNTIME_KIND,
          synthetic: true,
        }),
      ]),
      message("assistant_1", "assistant", [
        textPart("assistant_1", "I will delegate."),
        toolPart("assistant_1", "subagent_run"),
        toolPart("assistant_1", "subagent_status"),
        toolPart("assistant_1", "subagent_close"),
      ]),
      message("assistant_2", "assistant", [toolPart("assistant_2", "skill")]),
    ];
    const definitions = [
      definition("subagent_run", "builtin"),
      definition("subagent_status", "builtin"),
      definition("subagent_close", "builtin"),
      definition("mcp_search", "mcp"),
      definition("skill", "skill"),
    ];
    const tools = definitions.map((item) => requestTool(item.name));
    const context = assembledContext(history);
    const tailDirectives = [{ role: "system" as const, content: "finish now" }];

    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context, tools, tailDirectives),
        tailDirectives,
        toolDefinitions: definitions,
      },
      characterCounter(),
    );

    expect(composition).toBeDefined();
    for (const tokens of Object.values(composition ?? {})) {
      expect(tokens).toBeGreaterThan(0);
    }
  });

  it.each(["subagent_run", "subagent_status", "subagent_close"])(
    "classifies %s exchanges without relying on another subagent tool name",
    (toolName) => {
      const context = assembledContext([
        message("assistant_1", "assistant", [
          toolPart("assistant_1", toolName),
        ]),
      ]);
      const composition = estimateContextOccupancyComposition(
        {
          context,
          request: matchingRequest(context),
          toolDefinitions: [],
        },
        characterCounter(),
      );

      expect(composition?.["subagent-exchanges"]).toBeGreaterThan(0);
      expect(composition?.conversation).toBe(0);
    },
  );

  it("maps module tool schemas to builtin tools", () => {
    const definitions = [definition("module_probe", "module")];
    const context = assembledContext([]);
    const tools = [requestTool("module_probe")];
    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context, tools),
        toolDefinitions: definitions,
      },
      characterCounter(),
    );

    expect(composition?.["builtin-tools"]).toBeGreaterThan(0);
    expect(composition?.mcp).toBe(0);
    expect(composition?.skills).toBe(0);
  });

  it("keeps MCP schemas out of builtin tools", () => {
    const context = assembledContext([]);
    const tools = [requestTool("mcp_search")];
    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context, tools),
        toolDefinitions: [definition("mcp_search", "mcp")],
      },
      characterCounter(),
    );

    expect(composition?.mcp).toBeGreaterThan(0);
    expect(composition?.["builtin-tools"]).toBe(0);
  });

  it("groups skill directory schemas in skills rather than builtin tools", () => {
    const definitions = [
      definition("skill", "skill"),
      definition("skill_resource", "skill"),
    ];
    const context = assembledContext([]);
    const tools = definitions.map((item) => requestTool(item.name));
    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context, tools),
        toolDefinitions: definitions,
      },
      characterCounter(),
    );

    expect(composition?.skills).toBeGreaterThan(0);
    expect(composition?.["builtin-tools"]).toBe(0);
  });

  it("uses runtime provenance before the physical user wire role", () => {
    const runtimeOnly = message("user_1", "user", [
      textPart("user_1", "runtime context", {
        metadataKind: MODEL_CONTEXT_RUNTIME_KIND,
        synthetic: true,
      }),
    ]);
    const context = assembledContext([runtimeOnly]);
    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context),
        toolDefinitions: [],
      },
      characterCounter(),
    );

    expect(composition?.["system-prompt"]).toBeGreaterThan(0);
    expect(composition?.conversation).toBe(0);
  });

  it("keeps context summaries out of ordinary conversation", () => {
    const summaryOnly = message("summary_1", "assistant", [
      textPart("summary_1", "compressed history", {
        metadataKind: "context-summary",
        synthetic: true,
      }),
    ]);
    const context = assembledContext([summaryOnly]);
    const composition = estimateContextOccupancyComposition(
      {
        context,
        request: matchingRequest(context),
        toolDefinitions: [],
      },
      characterCounter(),
    );

    expect(composition?.["summarized-conversation"]).toBeGreaterThan(0);
    expect(composition?.conversation).toBe(0);
  });

  it("keeps loaded skill results in conversation rather than skill schemas", () => {
    const skillResult = message("assistant_1", "assistant", [
      toolPart("assistant_1", "skill"),
    ]);
    const withoutResultContext = assembledContext([]);
    const withResultContext = assembledContext([skillResult]);
    const withoutResult = estimateContextOccupancyComposition(
      {
        context: withoutResultContext,
        request: matchingRequest(withoutResultContext),
        toolDefinitions: [],
      },
      characterCounter(),
    );
    const withResult = estimateContextOccupancyComposition(
      {
        context: withResultContext,
        request: matchingRequest(withResultContext),
        toolDefinitions: [],
      },
      characterCounter(),
    );

    expect(withResult?.conversation).toBeGreaterThan(
      withoutResult?.conversation ?? 0,
    );
    expect(withResult?.skills).toBe(0);
  });

  it("counts active reasoning only when the wire request carries it on a tool call", () => {
    const textOnly = message("assistant_text", "assistant", [
      textPart("assistant_text", "plain answer"),
    ]);
    const toolCall = message("assistant_tool", "assistant", [
      toolPart("assistant_tool", "read_file"),
    ]);
    const estimate = (
      history: readonly MessageWithParts[],
      activeReasoningByMessageId?: ReadonlyMap<string, string>,
    ): number => {
      const context = assembledContext(history);
      return (
        estimateContextOccupancyComposition(
          {
            activeReasoningByMessageId,
            context,
            request: matchingRequest(
              context,
              [],
              [],
              activeReasoningByMessageId,
            ),
            toolDefinitions: [],
          },
          characterCounter(),
        )?.conversation ?? 0
      );
    };

    expect(
      estimate(
        [textOnly],
        new Map([["assistant_text", "not projected to the wire"]]),
      ),
    ).toBe(estimate([textOnly]));
    expect(
      estimate(
        [toolCall],
        new Map([["assistant_tool", "projected reasoning"]]),
      ),
    ).toBeGreaterThan(estimate([toolCall]));
  });

  it("omits composition when non-empty wire tools have no definitions", () => {
    const context = assembledContext([]);
    const tools = [requestTool("legacy_tool")];
    expect(
      estimateContextOccupancyComposition(
        {
          context,
          request: matchingRequest(context, tools),
        },
        characterCounter(),
      ),
    ).toBeUndefined();
  });

  it("omits composition when tool definition names or order do not match", () => {
    const context = assembledContext([]);
    const tools = [requestTool("first"), requestTool("second")];
    expect(
      estimateContextOccupancyComposition(
        {
          context,
          request: matchingRequest(context, tools),
          toolDefinitions: [
            definition("second", "builtin"),
            definition("first", "mcp"),
          ],
        },
        characterCounter(),
      ),
    ).toBeUndefined();
  });

  it("omits composition when reconstructed messages differ from the final request", () => {
    const context = assembledContext([
      message("user_1", "user", [textPart("user_1", "actual message")]),
    ]);

    expect(
      estimateContextOccupancyComposition(
        {
          context,
          request: {
            ...matchingRequest(context),
            messages: [{ role: "user", content: "different message" }],
          },
          toolDefinitions: [],
        },
        characterCounter(),
      ),
    ).toBeUndefined();
  });
});
