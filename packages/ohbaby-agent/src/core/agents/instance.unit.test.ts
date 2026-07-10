import { describe, expect, it, vi } from "vitest";
import { createAgentInstanceFactory } from "./instance.js";
import type { AgentRunDeps, AgentRunner, AgentRunResult } from "./types.js";

function createDeps(): AgentRunDeps {
  return {
    messageManager: {} as AgentRunDeps["messageManager"],
    runCoordinator: {} as AgentRunDeps["runCoordinator"],
    toolScheduler: {} as AgentRunDeps["toolScheduler"],
  };
}

function emptyEvents(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        next(): Promise<IteratorResult<never, undefined>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

describe("AgentInstance", () => {
  it("keeps stable identity and scope across turns", async () => {
    const result: AgentRunResult = {
      finalOutput: "ok",
      mode: "waitForCompletion",
      sessionId: "child_1",
      success: true,
    };
    const runner = vi.fn<AgentRunner>(() => Promise.resolve(result));
    const factory = createAgentInstanceFactory({
      deps: createDeps(),
      runner,
    });
    const instance = factory.create({
      agentName: "explore",
      contextScopeId: "subagent_1",
      instanceId: "subagent_1",
      maxSteps: 7,
      modelId: "fake-model",
      parentSessionId: "parent_1",
      projectRoot: "/repo",
      sessionId: "child_1",
      type: "sub",
    });

    await instance.turn({ prompt: "first", waitMode: "waitForCompletion" });
    await instance.turn({ prompt: "second", waitMode: "waitForCompletion" });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        contextScope: instance.contextScope,
        initialUserPrompt: "first",
        sessionId: "child_1",
      }),
      expect.objectContaining({
        contextScope: instance.contextScope,
        initialUserPrompt: "second",
        sessionId: "child_1",
      }),
    ]);
  });

  it("runs primary instances through the same turn boundary without a context scope id", async () => {
    const result: AgentRunResult = {
      events: emptyEvents(),
      mode: "stream",
      runId: "run_primary",
      sessionId: "primary_1",
    };
    const runner = vi.fn<AgentRunner>(() => Promise.resolve(result));
    const factory = createAgentInstanceFactory({
      deps: createDeps(),
      runner,
    });
    const instance = factory.create({
      agentName: "build",
      instanceId: "primary_1",
      maxSteps: 12,
      modelId: "fake-model",
      projectRoot: "/repo",
      sessionId: "primary_1",
      type: "primary",
    });

    await instance.turn({
      prompt: "hello",
      runId: "run_primary",
      waitMode: "stream",
    });

    expect(instance.contextScope.contextScopeId).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contextScope: instance.contextScope,
        initialUserPrompt: "hello",
        runId: "run_primary",
        sessionId: "primary_1",
        waitMode: "stream",
      }),
    );
  });
});
