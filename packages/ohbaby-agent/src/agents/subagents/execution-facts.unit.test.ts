import { expect, it } from "vitest";
import {
  collectExecutionFacts,
  renderExecutionFacts,
} from "./execution-facts.js";
import type { SubagentExecutionRecord } from "./execution-store.js";
import type {
  MessagePage,
  MessageWithParts,
} from "../../core/message/types.js";
const execution: SubagentExecutionRecord = {
  executionId: "execution",
  requestId: "call",
  requesterRunId: "root",
  requesterScopeId: "primary",
  parentSessionId: "parent",
  rootRunId: "root",
  rootSessionId: "parent",
  subagentId: "subagent",
  mode: "background",
  prompt: "SECRET PROMPT",
  output: "SECRET OUTPUT",
  createdAt: 1,
  updatedAt: 2,
  status: "running",
  childSessionId: "child",
  childScopeId: "scope",
  childRunId: "child-run",
  artifact: { state: "none" },
  delivery: { state: "none" },
};
it("projects bounded tool facts without leaking report, reasoning or tool bodies", async () => {
  const messages: MessageWithParts[] = [
    {
      info: {
        id: "message",
        sessionId: "child",
        contextScopeId: "scope",
        runId: "child-run",
        role: "assistant",
        agent: "explore",
        time: { created: 4, updated: 8 },
      },
      parts: Array.from({ length: 30 }, (_, i) => ({
        id: `part${String(i)}`,
        messageId: "message",
        sessionId: "child",
        contextScopeId: "scope",
        orderIndex: i,
        type: "tool" as const,
        callId: `call${String(i)}`,
        tool: "read",
        state: {
          status: "completed" as const,
          input: { secret: "SECRET ARGS" },
          output: "SECRET TOOL BODY",
        },
        metadata: {
          execution: {
            runId: "child-run",
            phase: "ended" as const,
            createdAt: i,
            phaseStartedAt: i + 1,
            endedAt: i + 1,
            outcome: "error" as const,
          },
        },
      })),
    },
  ];
  const fact = await collectExecutionFacts({
    execution,
    now: () => 999,
    messages: {
      listPageByRun: (_sessionId, _runId, options): Promise<MessagePage> => {
        expect(options?.scope?.contextScopeId).toBe("scope");
        return Promise.resolve({ messages, hasMore: false });
      },
    },
  });
  expect(fact.collectedAt).toBe(999);
  expect(fact.lastActivityAt).toBe(8);
  expect(fact.recentTools).toHaveLength(5);
  expect(fact.omittedTools).toBe(25);
  const rendered = renderExecutionFacts(Array.from({ length: 60 }, () => fact));
  expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(16384);
  expect(rendered).not.toContain("SECRET");
  expect(rendered).toContain("omittedExecutions");
});
it("never promotes missing child/run facts to thinking or pure approval", async () => {
  const fact = await collectExecutionFacts({
    execution: { ...execution, childRunId: undefined },
    messages: {
      listPageByRun: () => Promise.reject(new Error("must not query")),
    },
  });
  expect(fact.phase).toBe("unknown");
  expect(fact.approval.blocked).toBe(false);
});

it("marks truncated source facts as incomplete", async () => {
  const fact = await collectExecutionFacts({
    execution,
    messages: {
      listPageByRun: () => Promise.resolve({ messages: [], hasMore: true }),
    },
  });
  expect(fact).toMatchObject({
    sourceTruncated: true,
    approval: { blocked: false },
  });
});
