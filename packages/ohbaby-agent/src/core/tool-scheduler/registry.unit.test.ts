import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

function createTool(input: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    description: `${input.name} description`,
    execute: () => Promise.resolve({ output: input.name }),
    parametersJsonSchema: {},
    source: "builtin",
    ...input,
  };
}

describe("ToolRegistry", () => {
  it("registers tools and infers built-in, module, and MCP categories", () => {
    const registry = createToolRegistry();

    registry.register(createTool({ name: "read" }));
    registry.register(createTool({ name: "memory_add", source: "module" }));
    registry.register(
      createTool({
        annotations: { readOnlyHint: true },
        name: "mcp_read",
        source: "mcp",
      }),
    );
    registry.register(createTool({ name: "mcp_write", source: "mcp" }));
    registry.registerCategory("custom", "dangerous");

    expect(registry.get("read")?.name).toBe("read");
    expect(registry.getCategory("read")).toBe("readonly");
    expect(registry.getCategory("memory_add")).toBe("memory");
    expect(registry.getCategory("mcp_read")).toBe("readonly");
    expect(registry.getCategory("mcp_write")).toBe("write");
    expect(registry.getCategory("custom")).toBe("dangerous");
  });

  it("filters tools by mode, agent config, and subagent restrictions", () => {
    const registry = createToolRegistry();
    const parameters = {
      properties: { path: { type: "string" } },
      required: ["path"],
      type: "object",
    };
    for (const toolName of [
      "read",
      "edit",
      "web_search",
      "memory_add",
      "task",
    ]) {
      registry.register(
        createTool({
          name: toolName,
          parametersJsonSchema: toolName === "read" ? parameters : {},
        }),
      );
    }

    expect(
      registry
        .getAvailableTools({
          mode: "plan",
          tools: { web_search: false },
        })
        .map((tool) => tool.name),
    ).toEqual(["read", "memory_add"]);
    expect(
      registry
        .getAvailableTools({
          isSubagent: true,
          mode: "agent",
          tools: { "*": true },
        })
        .map((tool) => tool.name),
    ).toEqual(["read", "edit", "web_search", "memory_add"]);
    expect(
      registry
        .getAvailableTools({
          mode: "agent",
          tools: { "*": false, read: true },
        })
        .map((tool) => tool.name),
    ).toEqual(["read"]);
    expect(
      registry
        .getAvailableTools({ mode: "agent" })
        .find((tool) => tool.name === "read")?.parameters,
    ).toBe(parameters);
  });
});
