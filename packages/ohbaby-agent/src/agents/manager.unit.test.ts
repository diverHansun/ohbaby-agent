import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { AgentsConfig, SystemPromptProvider } from "./types.js";

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
  const build: SystemPromptProvider["build"] = ({ agent }) =>
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

  it("builds a runtime agent using the injected system prompt provider", async () => {
    const build = vi.fn<SystemPromptProvider["build"]>(
      ({ agent, isSubagent }) => `${agent.name}:${String(isSubagent)}`,
    );
    const provider: SystemPromptProvider = {
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

    expect(runtimeAgent.systemPrompt).toContain(
      "focused code exploration subagent",
    );
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
});
