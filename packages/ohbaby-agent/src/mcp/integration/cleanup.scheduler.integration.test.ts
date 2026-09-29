import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "../../core/tool-scheduler/scheduler.js";
import type {
  ToolCallResult,
  ToolExecutionFact,
} from "../../core/tool-scheduler/types.js";
import type { McpClientLike } from "../types.js";
import { adaptMcpTool } from "./tool-adapter.js";
import { admitMcpTool } from "./dynamic-tool-menu.js";

function fixture(callTool: McpClientLike["callTool"]): {
  scheduler: ReturnType<typeof createToolScheduler>;
  facts: ToolExecutionFact[];
  execute: (callId: string) => Promise<ToolCallResult>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const disconnect = vi.fn(() => Promise.resolve());
  const client: McpClientLike = {
    name: "cleanup-fixture",
    config: {
      type: "stdio",
      command: "fixture",
      args: [],
      enabled: true,
      trust: true,
      timeout: 5000,
    },
    connect: () => Promise.resolve(),
    disconnect,
    listTools: () => Promise.resolve([]),
    getStatus: () => ({ status: "connected", toolCount: 1 }),
    callTool,
  };
  const tool = adaptMcpTool(
    { name: "work", inputSchema: { type: "object" } },
    client,
  );
  const bus = createBus();
  const facts: ToolExecutionFact[] = [];
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { concurrency: { maxConcurrency: 1 } },
    onExecutionFact(fact) {
      facts.push(fact);
    },
  });
  // Production composition sanitizes discovered MCP tools before registration.
  const admitted = admitMcpTool(tool).accepted[0];
  expect(admitted).toBeDefined();
  scheduler.register(admitted);
  const execute = (callId: string): Promise<ToolCallResult> =>
    scheduler.execute({
      callId,
      toolName: tool.name,
      sessionId: "session",
      messageId: "message",
      params: {},
    });
  return { scheduler, facts, execute, disconnect };
}

describe("MCP cancellation cleanup facts", () => {
  it("keeps remote cleanup unconfirmed after local abort rejection and returns capacity", async () => {
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let remoteActive = false;
    let calls = 0;
    const { scheduler, facts, execute, disconnect } = fixture(
      async (_request, options) => {
        if (++calls > 1)
          return {
            content: [{ type: "text", text: "next request completed" }],
          };
        remoteActive = true;
        enter();
        // SDK cancellation rejects the local request without a remote stop acknowledgement.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("Local request cancelled"));
            },
            { once: true },
          );
        });
      },
    );
    const original = execute("cancelled");
    try {
      await started;
      const next = execute("next");
      scheduler.cancel("cancelled");
      expect((await original).status).toBe("cancelled");
      expect((await next).status).toBe("success");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(remoteActive).toBe(true);
      expect(
        facts
          .filter(
            (fact) =>
              fact.owner.callId === "cancelled" && fact.phase === "cleanup",
          )
          .map((fact) => fact.cleanup),
      ).toEqual(["in-progress", "unconfirmed"]);
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      remoteActive = false;
      scheduler.cancelAll();
      await original;
    }
  });

  it.each([false, true])(
    "does not label a normal remote response as uncertain cleanup (isError=%s)",
    async (isError) => {
      const { execute, facts, disconnect } = fixture(() =>
        Promise.resolve({
          isError,
          content: [{ type: "text", text: "remote response" }],
        }),
      );
      expect((await execute("response")).status).toBe(
        isError ? "error" : "success",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(facts.filter((fact) => fact.phase === "cleanup")).toEqual([]);
      expect(disconnect).not.toHaveBeenCalled();
    },
  );
});
