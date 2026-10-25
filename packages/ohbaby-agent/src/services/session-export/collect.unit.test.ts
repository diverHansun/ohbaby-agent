import { describe, expect, it } from "vitest";
import type {
  MessageWithParts,
  Part,
  CreatePartInput,
} from "../../core/message/types.js";
import type { Session } from "../session/types.js";
import { collectExportDocument } from "./collect.js";
import type { ExportDependencies } from "./types.js";

const session: Session = {
  id: "session_1_abc",
  projectId: "project",
  workingDirectory: "/repo",
  title: "中文讨论",
  agentName: "build",
  status: "archived",
  createdAt: 1000,
  updatedAt: 2000,
  stats: { messageCount: 99 },
  childrenIds: [],
  isSubagent: false,
};
const now = new Date("2026-10-17T07:30:12Z");
function part(data: CreatePartInput, orderIndex = 0): Part {
  return {
    id: `part_${String(orderIndex)}`,
    sessionId: session.id,
    messageId: "assistant",
    orderIndex,
    ...data,
  };
}
function message(
  parts: Part[],
  overrides: Partial<MessageWithParts["info"]> = {},
): MessageWithParts {
  return {
    info: {
      id: "assistant",
      sessionId: session.id,
      role: "assistant",
      agent: "build",
      time: { created: 2000 },
      providerId: "provider",
      modelId: "model",
      ...overrides,
    } as MessageWithParts["info"],
    parts,
  };
}
function deps(
  messages: MessageWithParts[],
  value: Session | null = session,
): ExportDependencies {
  return {
    sessionManager: { get: () => Promise.resolve(value) },
    messageManager: {
      listBySession: (id, scope): Promise<MessageWithParts[]> => {
        expect(id).toBe(session.id);
        expect(scope).toEqual({ contextScopeId: undefined });
        return Promise.resolve(messages);
      },
    },
    appVersion: "1.2.3",
  };
}
const nativePart = part({
  type: "model-state",
  modelState: {
    version: 1,
    origin: {
      provider: "p",
      model: "m",
      protocol: "anthropic",
      endpoint: "__STATE_SECRET__",
    },
    output: {
      protocol: "anthropic",
      items: [
        {
          type: "thinking",
          thinking: "hidden",
          signature: "__SIGNATURE_SECRET__",
        },
      ],
    },
    estimate: { tokens: 10, source: "reasoning" },
  },
  metadata: {
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 8,
      reasoningTokens: 3,
      totalTokens: 18,
    },
  },
});

describe("collectExportDocument", () => {
  it("keeps visible history and compacted parts while excluding hidden fields", async () => {
    const input = [
      message([
        part(
          {
            type: "text",
            text: "__EXPANDED_SECRET__",
            metadata: { displayText: "你好 👋", sourceOrder: 1 },
          },
          0,
        ),
        part(
          {
            type: "reasoning",
            text: "思考",
            endReason: "interrupted",
            metadata: { sourceOrder: 0 },
          },
          1,
        ),
        part(
          {
            type: "text",
            text: "__CONTEXT_SECRET__",
            synthetic: true,
            metadata: { kind: "model-context:runtime:v1" },
          },
          2,
        ),
        nativePart,
        ...["select_tools", "todo_read"].map((tool, i) =>
          part(
            {
              type: "tool",
              tool,
              callId: tool,
              state: {
                status: "completed",
                input: {},
                output: "__INTERNAL_SECRET__",
              },
            },
            i + 3,
          ),
        ),
        part(
          {
            type: "tool",
            tool: "todo_write",
            callId: "plan",
            state: {
              status: "pending",
              input: { tasks: ["保留"] },
              raw: "__RAW_SECRET__",
            },
          },
          5,
        ),
        {
          ...part({ type: "text", text: "压缩前原文" }, 6),
          time: { compacted: 3000 },
        },
      ]),
    ];
    const before = structuredClone(input);
    const result = await collectExportDocument(deps(input), session.id, now);
    expect(result.header.version).toBe(1);
    expect(result.header.session.projectRoot).toBe(session.workingDirectory);
    expect(result.header.session).not.toHaveProperty("workingDirectory");
    expect(result.messages[0].parts).toEqual([
      { type: "reasoning", text: "思考", endReason: "interrupted" },
      { type: "text", text: "你好 👋" },
      {
        type: "tool",
        tool: "todo_write",
        callId: "plan",
        status: "pending",
        input: { tasks: ["保留"] },
      },
      { type: "text", text: "压缩前原文", compacted: true },
    ]);
    expect(result.header.stats).toEqual({
      messageCount: 1,
      models: ["provider/model"],
      tokens: { input: 10, output: 8, reasoning: 3, total: 18 },
      usageCoverage: { known: 1, unknown: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(/__[A-Z_]+SECRET__/);
    expect(input).toEqual(before);
  });

  it("preserves summaries, runtime results and interruption messages with their source roles", async () => {
    const input = [
      message(
        [
          part({
            type: "text",
            text: "摘要全文",
            synthetic: true,
            metadata: { kind: "context-summary" },
          }),
        ],
        {
          agent: "context",
          id: "summary",
          time: { created: 3000, completed: 4000 },
        },
      ),
      message([part({ type: "text", text: "子代理结果" })], {
        id: "result",
        role: "user",
        time: { created: 1000 },
        runtimeInput: {
          kind: "subagent-result",
          inputId: "i",
          targetRunId: "r",
          sourceId: "s",
        },
        system: "__SYSTEM_SECRET__",
        tools: { secret: true },
      }),
      message([part({ type: "text", text: "Stopped" })], {
        id: "abort",
        role: "system",
        kind: "abort",
        time: { created: 3000 },
      }),
    ];
    const result = await collectExportDocument(deps(input), session.id, now);
    expect(
      result.messages.map((m) => [m.id, m.role, m.kind, m.runtimeInput]),
    ).toEqual([
      ["result", "system", undefined, "subagent-result"],
      ["summary", "assistant", "compaction-summary", undefined],
      ["abort", "system", "abort", undefined],
    ]);
    expect(result.messages[1].parts).toEqual([
      { type: "text", text: "摘要全文" },
    ]);
    expect(JSON.stringify(result)).not.toContain("__SYSTEM_SECRET__");
    expect(result.header.session.status).toBe("archived");
  });

  it("sums request usage once, ignores the legacy carrier when requests exist and marks unknown usage", async () => {
    const requests = [
      {
        requestId: "r1",
        runId: "r",
        messageId: "a",
        step: 1,
        attempt: 1,
        purpose: "agent-step" as const,
        startedAt: 1,
        outcome: "success" as const,
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          reasoningTokens: 10,
          totalTokens: 130,
        },
      },
      {
        requestId: "r2",
        runId: "r",
        messageId: "a",
        step: 2,
        attempt: 1,
        purpose: "agent-step" as const,
        startedAt: 2,
        outcome: "success" as const,
        usage: {
          inputTokens: 200,
          outputTokens: 40,
          reasoningTokens: 20,
          totalTokens: 240,
        },
      },
    ];
    const result = await collectExportDocument(
      deps([
        message([part({ type: "text", text: "known" }), nativePart], {
          modelRequests: requests,
        }),
        message(
          [
            part({
              type: "tool",
              tool: "subagent_run",
              callId: "c",
              state: { status: "running", input: {} },
            }),
          ],
          {
            id: "unknown",
            modelRequests: [
              { ...requests[0], usage: undefined, outcome: "running" },
            ],
          },
        ),
      ]),
      session.id,
      now,
    );
    expect(result.messages[0].usage).toEqual({
      input: 300,
      output: 70,
      reasoning: 30,
      total: 370,
    });
    expect(result.messages[1].usage).toBeUndefined();
    expect(result.messages[1].status).toBe("running");
    expect(result.header.stats.usageCoverage).toEqual({ known: 1, unknown: 1 });
  });

  it("marks a partially metered message incomplete while retaining its known usage", async () => {
    const common = {
      requestId: "r",
      runId: "run",
      messageId: "m",
      step: 1,
      attempt: 1,
      purpose: "agent-step" as const,
      startedAt: 1,
      outcome: "success" as const,
    };
    const result = await collectExportDocument(
      deps([
        message([part({ type: "text", text: "partial" })], {
          modelRequests: [
            {
              ...common,
              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
            },
            { ...common, requestId: "unknown", usage: undefined },
          ],
        }),
      ]),
      session.id,
      now,
    );
    expect(result.messages[0]).toMatchObject({
      usage: { input: 7, output: 3, total: 10 },
      usageComplete: false,
    });
    expect(result.header.stats).toMatchObject({
      tokens: { input: 7, output: 3, total: 10 },
      usageCoverage: { known: 0, unknown: 1 },
    });
    expect(result.header.stats.tokens).not.toHaveProperty("reasoning");
  });

  it("does not present missing usage as zero and excludes messages with only hidden parts", async () => {
    const result = await collectExportDocument(
      deps([
        message([nativePart]),
        message([part({ type: "text", text: "visible" })], { id: "visible" }),
      ]),
      session.id,
      now,
    );
    expect(result.header.stats.messageCount).toBe(1);
    expect(result.header.stats.tokens).toBeUndefined();
    expect(result.header.stats.usageCoverage).toEqual({ known: 0, unknown: 1 });
  });

  it.each([
    [null, [], "SESSION_NOT_FOUND"],
    [{ ...session, isSubagent: true }, [], "SUBAGENT_SESSION"],
    [session, [], "EMPTY_SESSION"],
  ] as const)(
    "rejects unavailable or empty sessions (%s)",
    async (value, messages, code) => {
      await expect(
        collectExportDocument(deps([...messages], value), session.id, now),
      ).rejects.toMatchObject({ code });
    },
  );
});
