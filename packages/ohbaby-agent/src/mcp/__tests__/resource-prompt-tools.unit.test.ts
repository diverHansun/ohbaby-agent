import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../../core/tool-scheduler/index.js";
import {
  createMcpPromptTool,
  createMcpResourceTool,
} from "../integration/resource-prompt-tools.js";
import type { McpGetPromptResult, McpReadResourceResult } from "../types.js";

function executionContext(): ToolExecutionContext {
  return {
    callId: "call-1",
    messageId: "message-1",
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
}

describe("MCP resource and prompt tools", () => {
  it("reads an MCP resource through an untrusted MCP tool", async () => {
    const readResource = vi.fn(
      (_serverName: string, uri: string): Promise<McpReadResourceResult> =>
        Promise.resolve({
          contents: [{ text: `content from ${uri}`, type: "text", uri }],
        }),
    );
    const tool = createMcpResourceTool({ readResource });

    await expect(
      tool.execute(
        { server: "fs", uri: "file:///README.md" },
        executionContext(),
      ),
    ).resolves.toEqual({
      metadata: {
        contentCount: 1,
        server: "fs",
        source: "mcp",
        uri: "file:///README.md",
      },
      output: "content from file:///README.md",
    });
    expect(tool.category).toBe("readonly");
    expect(tool.requireExplicitApproval).toBe(true);
    expect(tool.source).toBe("mcp");
  });

  it("gets an MCP prompt through an untrusted MCP tool", async () => {
    const getPrompt = vi.fn(
      (
        _serverName: string,
        name: string,
        _args?: Record<string, string>,
      ): Promise<McpGetPromptResult> =>
        Promise.resolve({
          messages: [
            {
              content: { text: `prompt ${name}`, type: "text" },
              role: "user",
            },
          ],
        }),
    );
    const tool = createMcpPromptTool({ getPrompt });

    await expect(
      tool.execute(
        { args: { topic: "runtime" }, name: "summarize", server: "docs" },
        executionContext(),
      ),
    ).resolves.toEqual({
      metadata: {
        messageCount: 1,
        name: "summarize",
        server: "docs",
        source: "mcp",
      },
      output: JSON.stringify(
        [
          {
            content: { text: "prompt summarize", type: "text" },
            role: "user",
          },
        ],
        null,
        2,
      ),
    });
    expect(getPrompt).toHaveBeenCalledWith("docs", "summarize", {
      topic: "runtime",
    });
    expect(tool.category).toBe("readonly");
    expect(tool.requireExplicitApproval).toBe(true);
    expect(tool.source).toBe("mcp");
  });
});
