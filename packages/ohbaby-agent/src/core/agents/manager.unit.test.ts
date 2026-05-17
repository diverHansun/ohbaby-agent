import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "./manager.js";
import { AgentRegistry } from "./registry.js";
import type { SystemPromptProvider } from "./types.js";

async function createManager(): Promise<AgentManager> {
  const registry = new AgentRegistry({
    configLoader: () => ({
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
  return new AgentManager({
    registry,
    systemPromptProvider: {
      build: vi.fn(async ({ agent }) => `system:${agent.name}`),
    },
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
      grep: true,
      read: true,
      task: false,
      todo_read: false,
      todo_write: false,
    });
  });

  it("builds a runtime agent using the injected system prompt provider", async () => {
    const provider: SystemPromptProvider = {
      build: vi.fn(
        async ({ agent, isSubagent }) => `${agent.name}:${String(isSubagent)}`,
      ),
    };
    const registry = new AgentRegistry();
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
    expect(provider.build).toHaveBeenCalledWith({
      agent: expect.objectContaining({ name: "explore" }),
      isSubagent: true,
    });
  });
});
