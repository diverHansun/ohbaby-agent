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
});
