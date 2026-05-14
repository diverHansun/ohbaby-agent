import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { Lifecycle } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { createToolScheduler } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  PolicyPort,
  Tool,
  ToolExecutionEnvironment,
} from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/providers/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        if (nextBatch >= eventBatches.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const events = eventBatches[nextBatch];
        nextBatch += 1;
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

function createEnvironment(workdir: string): ToolExecutionEnvironment {
  return {
    workdir,
    resolvePath(inputPath: string): string {
      return `${workdir}/${inputPath}`;
    },
    resolvePathForExisting(inputPath: string): Promise<string> {
      return Promise.resolve(`${workdir}/${inputPath}`);
    },
    resolvePathForWrite(inputPath: string): Promise<string> {
      return Promise.resolve(`${workdir}/${inputPath}`);
    },
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return { cwd: workdir, kind: "host-local" };
    },
  };
}

function createAllowPolicy(): PolicyPort {
  return {
    check: () => ({ type: "allow" }),
    getMode: () => "agent",
  };
}

async function consumeLifecycle(
  loop: ReturnType<Lifecycle["run"]>,
): Promise<Awaited<ReturnType<ReturnType<Lifecycle["run"]>["next"]>>["value"]> {
  let next = await loop.next();
  while (!next.done) {
    next = await loop.next();
  }
  return next.value;
}

describe("lifecycle tool scheduler integration", () => {
  it("executes a fake tool through the real scheduler and feeds results to the next LLM step", async () => {
    const requests: ProviderRequest[] = [];
    const bus = createBus();
    const scheduler = createToolScheduler({
      bus,
      permission: { ask: () => "once" },
      policy: createAllowPolicy(),
    });
    const execute = vi.fn<Tool["execute"]>((params, context) => {
      return {
        output: JSON.stringify({
          params,
          workdir: context.environment?.workdir,
          commandCwd: context.environment?.resolveCommandContext().cwd,
        }),
      };
    });
    scheduler.register({
      category: "readonly",
      description: "Read a fake file",
      execute,
      name: "read_fake",
      parametersJsonSchema: {
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      source: "builtin",
    });

    const lifecycle = new Lifecycle({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            {
              toolCallDeltas: [
                {
                  argumentsDelta: '{"path":"README.md"}',
                  id: "call_read",
                  index: 0,
                  name: "read_fake",
                },
              ],
              finishReason: "tool_calls",
            },
          ],
          [{ textDelta: "The fake file was read.", finishReason: "stop" }],
        ],
        requests,
      ),
      toolScheduler: scheduler,
    });

    const result = await consumeLifecycle(
      lifecycle.run({
        environment: createEnvironment("D:/workspace/session_1"),
        messages: [{ role: "user", content: "Read README" }],
        sessionId: "session_1",
      }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { path: "README.md" },
      expect.objectContaining({
        callId: "call_read",
        environment: expect.objectContaining({
          workdir: "D:/workspace/session_1",
        }),
        messageId: expect.stringContaining("session_1"),
        sessionId: "session_1",
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "Read README" },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "Read README" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read",
            function: {
              arguments: '{"path":"README.md"}',
              name: "read_fake",
            },
            type: "function",
          },
        ],
      },
      {
        role: "tool",
        content:
          '{"params":{"path":"README.md"},"workdir":"D:/workspace/session_1","commandCwd":"D:/workspace/session_1"}',
        tool_call_id: "call_read",
      },
    ]);
    expect(result).toMatchObject({
      finalResponse: "The fake file was read.",
      finishReason: "stop",
      success: true,
      toolCalls: [
        {
          arguments: { path: "README.md" },
          id: "call_read",
          name: "read_fake",
        },
      ],
    });
  });
});
