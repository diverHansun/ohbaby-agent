import { describe, expect, it } from "vitest";
import * as publicApi from "../../../packages/ohbaby-agent/src/index.js";
import * as agentsApi from "../../../packages/ohbaby-agent/src/agents/index.js";
import {
  AgentManager,
  AgentRegistry,
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
    expect(agentsApi.AgentService).toBeTypeOf("function");
    expect("SubagentExecutor" in agentsApi).toBe(false);
    expect("createSubagentRunner" in agentsApi).toBe(false);
    expect("SubagentExecutor" in publicApi).toBe(false);
    expect("SubagentRunner" in publicApi).toBe(false);
  });
});
