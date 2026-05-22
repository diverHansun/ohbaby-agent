import { describe, expect, it } from "vitest";
import { AgentRegistry } from "./registry.js";
import type { AgentsConfig } from "./types.js";

describe("AgentRegistry", () => {
  it("loads enabled builtin agents by default", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });

    await registry.initialize();

    expect(registry.get("build")).toMatchObject({
      default: true,
      mode: "primary",
      name: "build",
    });
    expect(registry.get("plan")).toMatchObject({
      mode: "primary",
      name: "plan",
    });
    expect(registry.get("explore")).toMatchObject({
      mode: "subagent",
      name: "explore",
    });
    expect(registry.get("research")).toMatchObject({
      mode: "subagent",
      name: "research",
    });
  });

  it("gives builtin subagents planning, shell, and file editing tools", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({ agents: {} }),
    });

    await registry.initialize();

    expect(registry.get("explore")?.tools?.include).toEqual(
      expect.arrayContaining([
        "bash",
        "edit",
        "todo_read",
        "todo_write",
        "write",
      ]),
    );
    expect(registry.get("research")?.tools?.include).toEqual(
      expect.arrayContaining([
        "bash",
        "edit",
        "todo_read",
        "todo_write",
        "write",
      ]),
    );
  });

  it("fully replaces same-name builtin agents and merges different names", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          build: {
            description: "Replacement build agent",
            mode: "primary",
            name: "build",
            tools: { include: ["read"] },
          },
          audit: {
            description: "Read-only audit subagent",
            mode: "subagent",
            name: "audit",
            tools: { include: ["read", "grep"] },
          },
        },
      }),
    });

    await registry.initialize();

    expect(registry.get("build")).toEqual({
      description: "Replacement build agent",
      mode: "primary",
      name: "build",
      tools: { include: ["read"] },
    });
    expect(registry.get("audit")).toMatchObject({
      mode: "subagent",
      name: "audit",
    });
    expect(registry.list().map((agent) => agent.name)).toContain("explore");
  });

  it("does not list disabled agents", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          research: {
            description: "Disabled research",
            disabled: true,
            mode: "subagent",
            name: "research",
          },
        },
      }),
    });

    await registry.initialize();

    expect(registry.get("research")).toBeUndefined();
    expect(registry.list().map((agent) => agent.name)).not.toContain(
      "research",
    );
  });

  it("rejects subagents without a description", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          broken: {
            mode: "subagent",
            name: "broken",
          },
        },
      }),
    });

    await expect(registry.initialize()).rejects.toThrow(
      "Subagent must have a description",
    );
  });

  it("rejects config-loaded agents with invalid modes", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          broken: {
            description: "Invalid mode",
            mode: "bogus" as never,
            name: "broken",
          },
        },
      }),
    });

    await expect(registry.initialize()).rejects.toThrow("Invalid agent mode");
  });

  it("rejects subagents that explicitly include recursive tools", async () => {
    for (const toolName of [
      "task",
      "agent_open",
      "agent_eval",
      "agent_status",
      "agent_close",
    ]) {
      const registry = new AgentRegistry({
        configLoader: (): AgentsConfig => ({
          agents: {
            recursive: {
              description: "Bad recursive subagent",
              mode: "subagent",
              name: "recursive",
              tools: { include: ["read", toolName] },
            },
          },
        }),
      });

      await expect(registry.initialize()).rejects.toThrow(
        `Subagent cannot enable disabled tool: ${toolName}`,
      );
    }
  });

  it("allows subagents to include session-scoped todo tools", async () => {
    const registry = new AgentRegistry({
      configLoader: (): AgentsConfig => ({
        agents: {
          planner: {
            description: "Plan a bounded child task",
            mode: "subagent",
            name: "planner",
            tools: { include: ["read", "todo_read", "todo_write"] },
          },
        },
      }),
    });

    await registry.initialize();

    expect(registry.get("planner")?.tools?.include).toEqual([
      "read",
      "todo_read",
      "todo_write",
    ]);
  });
});
