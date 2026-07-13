import { describe, expect, it } from "vitest";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { AgentsConfig } from "./types.js";

async function createManager(): Promise<AgentManager> {
  const registry = new AgentRegistry({
    configLoader: (): AgentsConfig => ({
      agents: {
        audit: {
          description: "Audit files",
          mode: "subagent",
          name: "audit",
          tools: { include: ["read", "grep"] },
        },
        narrow: {
          description: "Narrow primary",
          mode: "primary",
          name: "narrow",
          tools: { exclude: ["bash"], include: ["read", "bash", "edit"] },
        },
      },
    }),
  });
  await registry.initialize();
  return new AgentManager({ registry });
}

describe("AgentManager", () => {
  it("gets, lists, and resolves the default primary agent", async () => {
    const manager = await createManager();

    expect(manager.get("build")).toMatchObject({ name: "build" });
    expect(manager.getDefault()).toBe("build");
    expect(
      manager.list({ mode: "primary" }).map((agent) => agent.name),
    ).toEqual(["build", "plan", "narrow"]);
  });

  it("converts include and exclude tool config to scheduler booleans", async () => {
    const manager = await createManager();

    expect(manager.getAgentToolsConfig("narrow")).toEqual({
      "*": false,
      bash: false,
      edit: true,
      read: true,
    });
  });

  it("forces recursive tools off for subagents", async () => {
    const manager = await createManager();

    expect(manager.getAgentToolsConfig("audit")).toEqual({
      "*": false,
      grep: true,
      read: true,
      subagent_close: false,
      subagent_run: false,
      subagent_status: false,
    });
  });

  it("registers generic as the default broad subagent role", async () => {
    const manager = await createManager();

    expect(manager.get("generic")).toMatchObject({
      mode: "subagent",
      name: "generic",
    });
    expect(
      manager.getAgentToolsConfig("generic", { isSubagent: true }),
    ).toEqual({
      "*": false,
      bash: true,
      edit: true,
      glob: true,
      grep: true,
      list: true,
      memory_list: true,
      read: true,
      select_tools: true,
      skill: true,
      skill_resource: true,
      subagent_close: false,
      subagent_run: false,
      subagent_status: false,
      todo_read: true,
      todo_write: true,
      web_fetch: true,
      web_search: true,
      write: true,
    });
  });

  it("rejects primary agents when requested as subagents", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });
    await registry.initialize();
    const manager = new AgentManager({ registry });

    for (const primaryAgentName of ["build", "plan"] as const) {
      await expect(
        manager.getRuntimeAgent(primaryAgentName, { isSubagent: true }),
      ).rejects.toThrow(
        /primary agents|subagent roles|generic, explore, research/i,
      );
    }
  });
});
