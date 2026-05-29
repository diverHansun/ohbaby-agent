import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { AgentPromptProvider, AgentsConfig } from "./types.js";

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
  const build: AgentPromptProvider["build"] = ({ agent }) =>
    `system:${agent.name}`;
  return new AgentManager({
    registry,
    systemPromptProvider: { build },
  });
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
      agent_close: false,
      agent_eval: false,
      agent_open: false,
      agent_status: false,
      grep: true,
      read: true,
      task: false,
    });
  });

  it("registers generic as the default broad subagent role", async () => {
    const manager = await createManager();

    expect(manager.get("generic")).toMatchObject({
      mode: "subagent",
      name: "generic",
    });
    expect(manager.getAgentToolsConfig("generic", { isSubagent: true })).toEqual(
      {
        "*": false,
        agent_close: false,
        agent_eval: false,
        agent_open: false,
        agent_status: false,
        bash: true,
        edit: true,
        glob: true,
        grep: true,
        list: true,
        memory_list: true,
        read: true,
        task: false,
        todo_read: true,
        todo_write: true,
        web_fetch: true,
        web_search: true,
        write: true,
      },
    );
  });

  it("builds a runtime agent using the injected system prompt provider", async () => {
    const build = vi.fn<AgentPromptProvider["build"]>(
      ({ agent, isSubagent }) => `${agent.name}:${String(isSubagent)}`,
    );
    const provider: AgentPromptProvider = {
      build,
    };
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });
    await registry.initialize();
    const manager = new AgentManager({
      registry,
      systemPromptProvider: provider,
    });

    await expect(manager.getRuntimeAgent("explore")).resolves.toMatchObject({
      config: { name: "explore" },
      isSubagent: true,
      systemPrompt: "explore:true",
    });
    expect(build).toHaveBeenCalledOnce();
    const buildInput = build.mock.calls[0][0];
    expect(buildInput.agent.name).toBe("explore");
    expect(buildInput.isSubagent).toBe(true);
  });

  it("uses default system prompts for builtin subagents", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });
    await registry.initialize();
    const manager = new AgentManager({ registry });

    const runtimeAgent = await manager.getRuntimeAgent("explore");

    expect(runtimeAgent.systemPrompt).toContain("Task: explore");
    expect(runtimeAgent.systemPrompt).toContain("Code exploration task");
  });

  it("does not apply subagent task prompts to primary agents with matching names", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });
    await registry.initialize();
    const manager = new AgentManager({ registry });

    const runtimeAgent = await manager.getRuntimeAgent("plan");

    expect(runtimeAgent.isSubagent).toBe(false);
    expect(runtimeAgent.systemPrompt).not.toContain("<subagent_task>");
    expect(runtimeAgent.systemPrompt).not.toContain("Task: plan");
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

  it("uses custom subagent descriptions when no explicit prompt exists", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          audit: {
            description: "Audit code for release risks.",
            mode: "subagent",
            name: "audit",
          },
        },
      }),
    });
    await registry.initialize();
    const manager = new AgentManager({ registry });

    const runtimeAgent = await manager.getRuntimeAgent("audit");

    expect(runtimeAgent.systemPrompt).toContain(
      "Audit code for release risks.",
    );
  });

  it("treats configured prompts as add-ons for custom subagents", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          audit: {
            description: "Audit code for release risks.",
            mode: "subagent",
            name: "audit",
            prompt: "Focus on release blockers.",
          },
        },
      }),
    });
    await registry.initialize();
    const manager = new AgentManager({ registry });

    const runtimeAgent = await manager.getRuntimeAgent("audit");

    expect(runtimeAgent.systemPrompt).toContain("<subagent_base>");
    expect(runtimeAgent.systemPrompt).toContain("Task: generic");
    expect(runtimeAgent.systemPrompt).toContain(
      "Role: Audit code for release risks.",
    );
    expect(runtimeAgent.systemPrompt).toContain("<agent_prompt_addon>");
    expect(runtimeAgent.systemPrompt).toContain("Focus on release blockers.");
  });
});
