import { describe, expect, it } from "vitest";
import {
  formatToolResultContentForModel,
  projectToolMetadataForModel,
} from "./tool-metadata-projection.js";

describe("tool metadata projection", () => {
  it("projects new agent execution receipts while withholding raw task text", () => {
    expect(
      projectToolMetadataForModel("agent", {
        subagent: {
          action: "spawn",
          started: true,
          success: true,
          item: { name: "Audit", initialPrompt: "private task" },
          execution: {
            executionId: "e1",
            subagentId: "a1",
            mode: "background",
            status: "running",
            output: "large output",
          },
        },
      }),
    ).toEqual({
      action: "spawn",
      started: true,
      success: true,
      name: "Audit",
      executionId: "e1",
      subagentId: "a1",
      mode: "background",
      status: "running",
    });
  });
  it("keeps acceptance and capacity refusal facts when no new execution exists", () => {
    expect(
      projectToolMetadataForModel("agent", {
        subagent: {
          action: "send",
          started: false,
          accepted: true,
          inputId: "i1",
          agentId: "a1",
          executionId: "e1",
          mode: "foreground",
        },
      }),
    ).toEqual({
      action: "send",
      started: false,
      accepted: true,
      inputId: "i1",
      agentId: "a1",
      executionId: "e1",
      mode: "foreground",
    });
    expect(
      projectToolMetadataForModel("agent", {
        subagent: { action: "spawn", started: false, reason: "capacity" },
      }),
    ).toEqual({ action: "spawn", started: false, reason: "capacity" });
  });
  it("keeps the final monitor content within its budget without repeating metadata", () => {
    const result = {
      truncated: true,
      targets: Array.from({ length: 6 }, (_, index) => ({
        subagentId: `agent-${String(index)}`,
        cursor: "c".repeat(300),
        truncated: true,
        records: [{ text: "" }],
      })),
    };
    const byteLimit = 16 * 1024;
    result.targets[0].records[0].text = "x".repeat(
      byteLimit - Buffer.byteLength(JSON.stringify(result)),
    );
    const content = JSON.stringify(result);
    const formatted = formatToolResultContentForModel({
      tool: "agent",
      content,
      metadata: { agentMonitor: result },
    });
    expect(Buffer.byteLength(formatted)).toBeLessThanOrEqual(byteLimit);
    expect(JSON.parse(formatted)).toEqual(result);
    expect(
      projectToolMetadataForModel("agent", { agentMonitor: result }),
    ).toEqual({});
  });
  it("preserves stop cleanup facts without copying instance history", () => {
    expect(
      projectToolMetadataForModel("agent", {
        subagentStop: {
          subagentId: "a1",
          stopped: true,
          cleanup: "unconfirmed",
          unprocessedMessages: [
            { inputId: "i1", text: "large input", reason: "stopped" },
          ],
          item: { initialPrompt: "private" },
        },
      }),
    ).toEqual({
      subagentId: "a1",
      stopped: true,
      cleanup: "unconfirmed",
      unprocessedMessages: [{ inputId: "i1", reason: "stopped" }],
    });
  });

  it("preserves read continuation without inventing an unknown total", () => {
    expect(
      projectToolMetadataForModel("read", {
        path: "/workspace/large.txt",
        nextCursor: "opaque",
        hasMore: true,
        lineCount: undefined,
        sizeBytes: 2000000,
      }),
    ).toEqual({
      path: "/workspace/large.txt",
      nextCursor: "opaque",
      hasMore: true,
    });
  });
  it("keeps search completeness separate from limited previews", () => {
    expect(
      projectToolMetadataForModel("grep", {
        count: 1,
        scanComplete: false,
        displayLimited: true,
        stopReason: "result_limit",
        processExited: true,
        raw: "not projected",
      }),
    ).toEqual({
      count: 1,
      scanComplete: false,
      displayLimited: true,
      stopReason: "result_limit",
      processExited: true,
    });
  });
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

  it("does not project a previous error as a background queued input's result", () => {
    expect(
      projectToolMetadataForModel("subagent_run", {
        subagent: {
          item: {
            subagentId: "child",
            status: "interrupted",
            error: "previous failure",
            pendingQueue: [{ prompt: "next" }],
          },
        },
      }),
    ).toEqual({ subagentId: "child", status: "queued" });
  });

  it.each(["bash", "task_output", "task_kill"])(
    "projects shell job mode and deadlines for %s",
    (tool) => {
      expect(
        projectToolMetadataForModel(tool, {
          cwd: "/workspace",
          deadline: 2_000,
          exitCode: null,
          jobId: "job_1",
          mode: "background",
          pid: 42,
          promotedAt: 1_500,
          signal: "SIGTERM",
          status: "timed_out",
          timeoutMs: 1_000,
          truncated: true,
        }),
      ).toEqual({
        deadline: 2_000,
        exitCode: null,
        jobId: "job_1",
        mode: "background",
        promotedAt: 1_500,
        signal: "SIGTERM",
        status: "timed_out",
        timeoutMs: 1_000,
        truncated: true,
      });
    },
  );

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

  it.each(["output", "stop"])(
    "keeps task %s facts separate from operation acceptance",
    (taskAction) => {
      const facts = {
        taskAction,
        jobId: "job_1",
        status: "cancelled",
        stopReason: "model",
        cleanup: "unconfirmed",
        exitCode: null,
        outputBytes: 0,
        outputComplete: false,
        ...(taskAction === "stop" ? { stopResult: "requested" } : {}),
      };
      expect(
        projectToolMetadataForModel("task", {
          ...facts,
          output: "raw output",
          outcome: "success",
        }),
      ).toEqual(facts);
    },
  );

  it("bounds task list summaries and preserves pagination without a single job result", () => {
    const projected = projectToolMetadataForModel("task", {
      taskAction: "list",
      jobId: "not-a-single-job",
      hasMore: true,
      nextCursor: "opaque-next-page",
      filteredCount: 101,
      pendingStartCount: 2,
      jobs: Array.from({ length: 101 }, (_, index) => ({
        jobId: `job_${String(index)}`,
        status: "timed_out",
        cleanup: "unconfirmed",
        output: "full log",
        outputTail: "tail",
        ownerId: "private-backend",
      })),
    });
    expect(projected).toMatchObject({
      taskAction: "list",
      hasMore: true,
      nextCursor: "opaque-next-page",
      filteredCount: 101,
      pendingStartCount: 2,
    });
    expect(projected).not.toHaveProperty("jobId");
    expect(projected.jobs).toHaveLength(100);
    expect((projected.jobs as unknown[])[0]).toEqual({
      jobId: "job_0",
      status: "timed_out",
      cleanup: "unconfirmed",
    });
    const realistic = projectToolMetadataForModel("task", {
      taskAction: "list",
      hasMore: false,
      filteredCount: 1,
      pendingStartCount: 0,
      jobs: [
        {
          jobId: "job_full",
          command: "pnpm test ".repeat(100),
          description: "Run the full suite",
          mode: "background",
          status: "failed",
          stopReason: null,
          cleanup: "confirmed",
          createdAt: 1,
          startedAt: 2,
          endedAt: 3,
          promotedAt: null,
          resultReadyAt: 4,
          settledAt: 5,
          timeoutMs: 86_400_000,
          exitCode: 1,
          signal: null,
          trackingReleasedAt: null,
          outputBytes: 12_345,
          outputComplete: true,
          outputTruncated: false,
          outputCheckpointAt: 3,
        },
      ],
    });
    expect(realistic.jobs).toEqual([
      {
        jobId: "job_full",
        mode: "background",
        status: "failed",
        stopReason: null,
        cleanup: "confirmed",
        exitCode: 1,
      },
    ]);
    expect(
      projectToolMetadataForModel("task", {
        taskAction: "unknown",
        jobId: "j",
      }),
    ).toEqual({});
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
