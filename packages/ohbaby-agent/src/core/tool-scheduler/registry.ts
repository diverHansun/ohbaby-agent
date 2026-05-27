import {
  BUILTIN_TOOL_CATEGORIES,
  SUBAGENT_DISABLED_TOOLS,
} from "./constants.js";
import type {
  Tool,
  ToolCategory,
  ToolDefinition,
  ToolRegistry,
} from "./types.js";

function inferCategory(tool: Tool): ToolCategory {
  if (tool.category) {
    return tool.category;
  }
  if (tool.source === "mcp") {
    return tool.annotations?.readOnlyHint === true ? "readonly" : "write";
  }

  return BUILTIN_TOOL_CATEGORIES[tool.name] ?? "write";
}

function isEnabledByAgentConfig(
  toolName: string,
  tools: Record<string, boolean> | undefined,
): boolean {
  if (!tools) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(tools, toolName)) {
    return tools[toolName];
  }
  if (Object.prototype.hasOwnProperty.call(tools, "*")) {
    return tools["*"];
  }

  return true;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();
  const categories = new Map<string, ToolCategory>();

  function toDefinition(tool: Tool): ToolDefinition {
    const category = categories.get(tool.name) ?? inferCategory(tool);
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema,
      category,
      source: tool.source,
    };
  }

  return {
    register(tool: Tool): void {
      tools.set(tool.name, tool);
      categories.set(tool.name, inferCategory(tool));
    },

    unregister(toolName: string): void {
      tools.delete(toolName);
      categories.delete(toolName);
    },

    registerCategory(toolName: string, category: ToolCategory): void {
      categories.set(toolName, category);
    },

    get(toolName: string): Tool | undefined {
      return tools.get(toolName);
    },

    getCategory(toolName: string): ToolCategory | undefined {
      return categories.get(toolName) ?? BUILTIN_TOOL_CATEGORIES[toolName];
    },

    getAvailableTools(input): ToolDefinition[] {
      return Array.from(tools.values())
        .map(toDefinition)
        .filter((tool) => isEnabledByAgentConfig(tool.name, input.tools))
        .filter(
          (tool) =>
            input.isSubagent !== true ||
            !SUBAGENT_DISABLED_TOOLS.has(tool.name),
        );
    },

    list(): ToolDefinition[] {
      return Array.from(tools.values()).map(toDefinition);
    },
  };
}
