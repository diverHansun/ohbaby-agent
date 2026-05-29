import { describe, expect, it } from "vitest";
import {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "./tool-metadata-projection.js";

describe("tool metadata projection", () => {
  it("projects subagent role metadata for task results", () => {
    expect(
      projectToolMetadataForModel("task", {
        subagent: {
          agentName: "legacy",
          description: "AI Events Researcher",
          name: "events-scout",
          role: "generic",
          sessionId: "child_1",
          success: true,
        },
      }),
    ).toEqual({
      description: "AI Events Researcher",
      name: "events-scout",
      role: "generic",
      sessionId: "child_1",
      success: true,
    });
  });

  it("projects background agent task role metadata", () => {
    expect(
      projectToolMetadataForModel("agent_open", {
        agentTask: {
          description: "Background auth exploration",
          name: "auth-scout",
          pendingInputCount: 0,
          role: "explore",
          sessionId: "child_1",
          status: "running",
          taskId: "task_1",
        },
      }),
    ).toEqual({
      description: "Background auth exploration",
      name: "auth-scout",
      pendingInputCount: 0,
      role: "explore",
      sessionId: "child_1",
      status: "running",
      taskId: "task_1",
    });
  });

  it("includes role metadata in model-visible tool result content", () => {
    expect(
      formatToolResultContentForModel({
        content: "child output",
        metadata: {
          subagent: {
            description: "AI Events Researcher",
            name: "events-scout",
            role: "generic",
            sessionId: "child_1",
            success: true,
          },
        },
        tool: "task",
      }),
    ).toContain(
      '<tool_metadata>\n{"role":"generic","name":"events-scout","description":"AI Events Researcher","sessionId":"child_1","success":true}\n</tool_metadata>',
    );
  });
});
