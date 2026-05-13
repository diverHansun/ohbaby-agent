import type { MemoryToolDefinition } from "./types.js";

export const MemoryTools = {
  memory_list: {
    name: "memory_list",
    category: "memory",
    operationType: "read",
    description: "List current long-term memory entries by scope.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
      },
      required: ["scope"],
    },
  },
  memory_add: {
    name: "memory_add",
    category: "memory",
    operationType: "write",
    description: "Save an important fact to long-term memory.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        fact: { type: "string" },
      },
      required: ["scope", "fact"],
    },
  },
  memory_update: {
    name: "memory_update",
    category: "memory",
    operationType: "write",
    description: "Update an existing memory entry by index.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        index: { type: "number" },
        newText: { type: "string" },
      },
      required: ["scope", "index", "newText"],
    },
  },
  memory_remove: {
    name: "memory_remove",
    category: "memory",
    operationType: "write",
    description: "Remove an existing memory entry by index.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project"] },
        index: { type: "number" },
      },
      required: ["scope", "index"],
    },
  },
} satisfies Record<string, MemoryToolDefinition>;
