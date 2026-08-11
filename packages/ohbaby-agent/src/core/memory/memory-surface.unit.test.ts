import { describe, expect, it } from "vitest";
import {
  exploreAgent,
  genericAgent,
  planAgent,
  researchAgent,
} from "../../agents/builtin/index.js";
import { createBuiltinTools } from "../../tools/index.js";

const ghostTools = [
  "memory_list",
  "memory_read",
  "memory_add",
  "memory_update",
  "memory_remove",
] as const;

describe("memory runtime surface", () => {
  it("does not register ghost memory tools or advertise them in builtin agents", () => {
    const toolNames = new Set(createBuiltinTools().map((tool) => tool.name));
    const agents = [planAgent, researchAgent, genericAgent, exploreAgent];

    for (const name of ghostTools) {
      expect(toolNames.has(name)).toBe(false);
      expect(
        agents.some((agent) => agent.tools?.include?.includes(name) ?? false),
      ).toBe(false);
    }
  });
});
