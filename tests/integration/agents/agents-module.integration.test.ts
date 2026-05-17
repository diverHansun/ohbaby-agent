import { describe, expect, it } from "vitest";
import {
  AgentManager,
  AgentRegistry,
  SubagentExecutor,
} from "../../../packages/ohbaby-agent/src/agents/index.js";

describe("agents module integration", () => {
  it("exposes the agent orchestration layer outside core", async () => {
    const registry = new AgentRegistry();
    await registry.initialize();
    const manager = new AgentManager({ registry });

    expect(manager.getDefault()).toBe("build");
    expect(manager.get("explore")).toMatchObject({
      mode: "subagent",
      name: "explore",
    });
    expect(SubagentExecutor).toBeTypeOf("function");
  });
});
