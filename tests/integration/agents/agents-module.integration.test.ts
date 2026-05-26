import { readFile } from "node:fs/promises";
import path from "node:path";
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

  it("keeps the primary UI adapter on AgentService instead of direct RunManager orchestration", async () => {
    const source = await readFile(
      path.resolve(
        process.cwd(),
        "packages/ohbaby-agent/src/adapters/ui-inprocess.ts",
      ),
      "utf8",
    );

    expect(source).not.toContain("runtime.getOpenAiTools");
    expect(source).not.toContain("runtime.buildPromptMessages");
    expect(source).not.toContain("runtime.runManager.create");
  });
});
