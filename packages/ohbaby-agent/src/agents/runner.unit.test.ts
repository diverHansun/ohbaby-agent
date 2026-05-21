import { describe, expect, it, vi } from "vitest";
import { createSubagentRunner } from "./runner.js";
import type { RuntimeAgent } from "./types.js";
import type { ChatCompletionMessage } from "../core/llm-client/index.js";
import type { MessageWithParts } from "../core/message/index.js";
import type {
  ToolDefinition,
  ToolExecutionEnvironment,
} from "../core/tool-scheduler/index.js";
import type { RunRecord } from "../runtime/run-manager/index.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const runtimeAgent: RuntimeAgent = {
  config: {
    description: "Explore",
    maxSteps: 7,
    mode: "subagent",
    name: "explore",
  },
  isSubagent: true,
  systemPrompt: "system",
  tools: {},
};

const readTool: ToolDefinition = {
  category: "readonly",
  description: "Read files",
  name: "read",
  parameters: {
    type: "object",
  },
  source: "builtin",
};

const runRecord: RunRecord = {
  createdAt: 1,
  disconnectMode: "continue",
  multitaskStrategy: "reject",
  permissionProfileId: "interactive",
  runId: "run_child",
  sessionId: "child",
  status: "pending",
  triggerSource: "user",
};

const environment: ToolExecutionEnvironment = {
  resolveCommandContext: () => ({ cwd: "D:/repo", kind: "host-local" }),
  resolvePath: (inputPath) => inputPath,
  resolvePathForExisting: (inputPath) => Promise.resolve(inputPath),
  resolvePathForWrite: (inputPath) => Promise.resolve(inputPath),
  workdir: "D:/repo",
};

const childMessages: MessageWithParts[] = [
  {
    info: {
      agent: "explore",
      id: "message_assistant",
      role: "assistant",
      sessionId: "child",
      time: { created: 1 },
    },
    parts: [
      {
        id: "part",
        messageId: "message_assistant",
        orderIndex: 0,
        sessionId: "child",
        text: "child result",
        type: "text",
      },
    ],
  },
];

describe("createSubagentRunner", () => {
  it("creates child runs with subagent messages, tools, max steps, and parent message id", async () => {
    const buildSubagentPromptMessages = vi.fn(() =>
      Promise.resolve([
        { content: "system", role: "system" } satisfies ChatCompletionMessage,
      ]),
    );
    const create = vi.fn(() => Promise.resolve(runRecord));
    const runner = createSubagentRunner({
      buildSubagentPromptMessages,
      fallbackProjectRoot: "D:/fallback",
      messageManager: {
        listBySession: vi.fn(() => Promise.resolve(childMessages)),
      },
      runManager: {
        cancel: vi.fn(),
        create,
        waitForCompletion: vi.fn(() =>
          Promise.resolve({ status: "succeeded" as const }),
        ),
      },
      sandboxManager: {
        setSessionEnvironment: vi.fn(),
      },
      toolScheduler: {
        getAvailableTools: vi.fn(() => Promise.resolve([readTool])),
      },
    });

    await expect(
      runner.run({
        agentName: "explore",
        parentMessageId: "message_user",
        parentSessionId: "parent",
        projectRoot: "D:/repo",
        prompt: "Find auth",
        runtimeAgent,
        sessionId: "child",
      }),
    ).resolves.toEqual({
      output: "child result",
      steps: 0,
      success: true,
      toolCalls: [],
    });

    expect(buildSubagentPromptMessages).toHaveBeenCalledWith({
      agentName: "explore",
      projectRoot: "D:/repo",
      sessionId: "child",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "explore",
        isSubagent: true,
        maxSteps: 7,
        parentMessageId: "message_user",
        sessionId: "child",
        tools: [
          {
            function: {
              description: "Read files",
              name: "read",
              parameters: { type: "object" },
            },
            type: "function",
          },
        ],
        triggerSource: "user",
      }),
    );
  });

  it("cancels the child run when the parent abort signal fires and clears sandbox state", async () => {
    const completion = deferred<{ readonly status: "cancelled" }>();
    const controller = new AbortController();
    const setSessionEnvironment = vi.fn();
    const cancel = vi.fn();
    const create = vi.fn(() => Promise.resolve(runRecord));
    const runner = createSubagentRunner({
      buildSubagentPromptMessages: vi.fn(() => Promise.resolve([])),
      messageManager: {
        listBySession: vi.fn(() => Promise.resolve([])),
      },
      runManager: {
        cancel,
        create,
        waitForCompletion: vi.fn(() => completion.promise),
      },
      sandboxManager: {
        setSessionEnvironment,
      },
      toolScheduler: {
        getAvailableTools: vi.fn(() => Promise.resolve([])),
      },
    });

    const run = runner.run({
      agentName: "explore",
      environment,
      parentSessionId: "parent",
      prompt: "Find auth",
      runtimeAgent,
      sessionId: "child",
      signal: controller.signal,
    });
    await vi.waitUntil(() => create.mock.calls.length === 1);

    controller.abort("parent aborted");
    expect(cancel).toHaveBeenCalledWith("run_child", "parent aborted");
    completion.resolve({ status: "cancelled" });

    await expect(run).resolves.toMatchObject({
      output: "",
      success: false,
    });
    expect(setSessionEnvironment).toHaveBeenNthCalledWith(
      1,
      "child",
      environment,
    );
    expect(setSessionEnvironment).toHaveBeenLastCalledWith("child", undefined);
  });

  it("uses the run completion error when no assistant text was written", async () => {
    const runner = createSubagentRunner({
      buildSubagentPromptMessages: vi.fn(() => Promise.resolve([])),
      messageManager: {
        listBySession: vi.fn(() => Promise.resolve([])),
      },
      runManager: {
        cancel: vi.fn(),
        create: vi.fn(() => Promise.resolve(runRecord)),
        waitForCompletion: vi.fn(() =>
          Promise.resolve({
            error: "child failed before assistant output",
            status: "failed" as const,
          }),
        ),
      },
      sandboxManager: {
        setSessionEnvironment: vi.fn(),
      },
      toolScheduler: {
        getAvailableTools: vi.fn(() => Promise.resolve([])),
      },
    });

    await expect(
      runner.run({
        agentName: "explore",
        parentSessionId: "parent",
        prompt: "Find auth",
        runtimeAgent,
        sessionId: "child",
      }),
    ).resolves.toMatchObject({
      output: "child failed before assistant output",
      success: false,
    });
  });
});
