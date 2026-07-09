import { describe, expect, it } from "vitest";
import {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "./tool-metadata-projection.js";

describe("tool metadata projection", () => {
  it("projects subagent_run instance metadata", () => {
    expect(
      projectToolMetadataForModel("subagent_run", {
        subagent: {
          item: {
            contextScopeId: "subagent_1",
            description: "AI Events Researcher",
            name: "events-scout",
            role: "generic",
            sessionId: "child_1",
            status: "completed",
            subagentId: "subagent_1",
          },
          success: true,
        },
      }),
    ).toEqual({
      contextScopeId: "subagent_1",
      description: "AI Events Researcher",
      name: "events-scout",
      role: "generic",
      sessionId: "child_1",
      status: "completed",
      subagentId: "subagent_1",
      success: true,
    });
  });

  it("projects subagent_status items", () => {
    expect(
      projectToolMetadataForModel("subagent_status", {
        subagentStatus: {
          items: [
            {
              contextScopeId: "subagent_1",
              role: "explore",
              sessionId: "child_1",
              status: "running",
              subagentId: "subagent_1",
            },
          ],
        },
      }),
    ).toEqual({
      items: [
        {
          contextScopeId: "subagent_1",
          role: "explore",
          sessionId: "child_1",
          status: "running",
          subagentId: "subagent_1",
        },
      ],
    });
  });

  it("includes subagent metadata in model-visible tool result content", () => {
    expect(
      formatToolResultContentForModel({
        content: "child output",
        metadata: {
          subagent: {
            item: {
              contextScopeId: "subagent_1",
              description: "AI Events Researcher",
              name: "events-scout",
              role: "generic",
              sessionId: "child_1",
              status: "completed",
              subagentId: "subagent_1",
            },
            success: true,
          },
        },
        tool: "subagent_run",
      }),
    ).toContain(
      '<tool_metadata>\n{"subagentId":"subagent_1","sessionId":"child_1","contextScopeId":"subagent_1","role":"generic","name":"events-scout","description":"AI Events Researcher","status":"completed","success":true}\n</tool_metadata>',
    );
  });
});
