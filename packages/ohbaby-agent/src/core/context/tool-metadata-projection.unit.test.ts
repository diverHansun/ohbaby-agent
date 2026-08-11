import { describe, expect, it } from "vitest";
import {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "./tool-metadata-projection.js";

describe("tool metadata projection", () => {
  it("projects the local select_tools MCP selection contract", () => {
    expect(
      projectToolMetadataForModel("select_tools", {
        ignored: "secret",
        mcpSelection: {
          alreadyLoaded: ["mcp_already"],
          candidates: [{ name: "mcp_search", score: 0.75 }],
          ignored: "secret",
          limitReached: [],
          loaded: ["mcp_search"],
          unknown: [],
        },
      }),
    ).toEqual({
      mcpSelection: {
        alreadyLoaded: ["mcp_already"],
        candidates: [{ name: "mcp_search", score: 0.75 }],
        limitReached: [],
        loaded: ["mcp_search"],
        unknown: [],
      },
    });
  });
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

  it("projects only the shell job fields for task tools", () => {
    expect(
      projectToolMetadataForModel("task_output", {
        cwd: "/workspace",
        exitCode: null,
        jobId: "job_1",
        pid: 42,
        signal: "SIGTERM",
        status: "timed_out",
        truncated: true,
      }),
    ).toEqual({
      exitCode: null,
      jobId: "job_1",
      signal: "SIGTERM",
      status: "timed_out",
      truncated: true,
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
