import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import type {
  ToolCallRequest,
  ToolExecutionOwner,
} from "../../core/tool-scheduler/types.js";
import { createPermissionState } from "../../permission/index.js";
import { createInMemorySessionManager } from "../../services/session/index.js";
import { SkillRegistry } from "../../skill/index.js";
import { createUiRuntimeComposition } from "./composition.js";
import { createHostLocalSandboxManager } from "./host-local-environment.js";

function unusedLlmClient(): LLMClientInstance {
  return {
    config: {
      baseUrl: "https://example.invalid/v1",
      maxTokens: 128,
      model: "no-model-request",
      provider: "fake",
      temperature: 0,
      apiKeyEnv: "UNUSED",
      interfaceProvider: "openai-compatible",
      modelProfiles: [
        {
          model: "no-model-request",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      client: {},
      id: "fake",
      kind: "openai-compatible",
      isAbortError: () => false,
      streamResponse: () =>
        Promise.reject(
          new Error("This integration test must not call the model"),
        ),
    },
  };
}

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createBashTool } from "../../tools/bash.js";
import { ShellJobRegistry } from "../../tools/shell-job-registry.js";

class Child extends EventEmitter {
  readonly pid = 424242;
  readonly stdin = { end: vi.fn() };
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stopped = false;
  finish(): void {
    this.stopped = true;
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

describe("composition Bash cleanup ownership", () => {
  it("passes exact root and execution ownership to foreground and background Bash on a reused instance", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "root-job-ownership-")),
    );
    const bus = createBus();
    const messages = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const sessions = createInMemorySessionManager({
      bus,
      messageCleaner: messages,
    });
    await sessions.create(root, { id: "primary", agentName: "build" });
    await sessions.create(root, {
      id: "child",
      parentId: "primary",
      agentName: "build",
    });
    const executions = new InMemorySubagentExecutionStore();
    for (const name of ["A", "B", "wrong-root"]) {
      const executionId = `execution-${name}`;
      await executions.accept({
        executionId,
        rootRunId: `root-${name}`,
        rootSessionId: name === "wrong-root" ? "other-primary" : "primary",
        requestId: `request-${name}`,
        requesterRunId: `root-${name}`,
        requesterScopeId: "primary",
        parentSessionId: "primary",
        subagentId: "reused-instance",
        mode: "background",
        prompt: name,
        createdAt: 1,
      });
      const lookup = { executionId, parentSessionId: "primary" };
      await executions.bindChild(
        lookup,
        { sessionId: "child", contextScopeId: "reused-instance" },
        2,
      );
      await executions.start(lookup, `child-${name}`, 3);
    }
    const sandbox = createHostLocalSandboxManager(root);
    const childLease = await sandbox.acquire({
      sessionId: "child",
      contextScopeId: "reused-instance",
    });
    const primaryLease = await sandbox.acquire("primary");
    const composition = await createUiRuntimeComposition({
      bus,
      messageManager: messages,
      sessionManager: sessions,
      subagentExecutionStore: executions,
      sandboxManager: sandbox,
      workdir: root,
      llmClient: unusedLlmClient(),
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      permission: { ask: () => Promise.resolve("reject") },
      mcpManager: { getAllTools: () => Promise.resolve([]) },
      goalExecutionControl: {
        interruptGoalExecution: () => Promise.resolve(),
      },
      skillRegistry: new SkillRegistry({
        loader: {
          loadContent: (): Promise<never> =>
            Promise.reject(new Error("No skills loaded")),
          scan: (): Promise<Map<string, never>> =>
            Promise.resolve(new Map<string, never>()),
        },
      }),
    });
    const owners: ToolExecutionOwner[] = [];
    const children: Child[] = [];
    const killTree = vi.fn(() => new Promise<void>(() => undefined));
    const registry = new ShellJobRegistry({
      killTree,
      probeTree: (child): "stopped" | "running" =>
        (child as unknown as Child).stopped ? "stopped" : "running",
    });
    const bash = createBashTool({
      registry,
      shell: { acceptable: () => "/bin/sh", killTree },
      preflight: () => Promise.resolve({ cdTargets: [], resolvedPaths: [] }),
      spawn: () => {
        const child = new Child();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const execute = bash.execute.bind(bash);
    bash.execute = (params, context): ReturnType<typeof execute> => {
      if (context.owner) owners.push(context.owner);
      return execute(params, context);
    };
    composition.toolScheduler.unregister("bash");
    composition.toolScheduler.register(bash);
    const request = (callId: string, runId?: string): ToolCallRequest => ({
      callId,
      runId,
      sessionId: "child",
      contextScopeId: "reused-instance",
      messageId: "message",
      toolName: "bash",
      environment: childLease,
      params: { command: "echo fixture", run_in_background: true },
    });
    let foreground:
      | ReturnType<typeof composition.toolScheduler.execute>
      | undefined;
    try {
      const a = await composition.toolScheduler.execute(
        request("background-A", "child-A"),
      );
      const b = await composition.toolScheduler.execute(
        request("background-B", "child-B"),
      );
      expect(a.error).toBeUndefined();
      expect(a.status).toBe("success");
      expect(b.status).toBe("success");
      foreground = composition.toolScheduler.execute({
        ...request("foreground-primary", "root-A"),
        sessionId: "primary",
        contextScopeId: undefined,
        environment: primaryLease,
        params: { command: "echo foreground" },
      });
      await expect.poll(() => owners.length).toBe(3);
      expect(owners).toMatchObject([
        { runId: "child-A", rootRunId: "root-A", executionId: "execution-A" },
        { runId: "child-B", rootRunId: "root-B", executionId: "execution-B" },
        { runId: "root-A", rootRunId: "root-A" },
      ]);
      expect(owners[2].executionId).toBeUndefined();
      for (const runId of [undefined, "unknown", "child-wrong-root"]) {
        const denied = await composition.toolScheduler.execute(
          request(`denied-${String(runId)}`, runId),
        );
        expect(denied.status).toBe("error");
        expect(denied.error?.message).toContain("execution ownership");
      }
      expect(children).toHaveLength(3);
      registry.cancelByRootRun("root-A");
      expect(killTree).toHaveBeenCalledTimes(2);
      expect(await foreground).toMatchObject({
        executionOutcome: "cancelled",
        metadata: { status: "cancelled" },
      });
      expect(
        registry.get(String(b.metadata?.jobId), "child", "reused-instance")
          .status,
      ).toBe("running");
      registry.cancelByRootRun("root-A");
      expect(killTree).toHaveBeenCalledTimes(2);
      expect(registry.hasActiveWork("root-A")).toBe(true);
      children[0].finish();
      children[2].finish();
      expect(registry.hasActiveWork("root-A")).toBe(false);
      expect(registry.hasActiveWork("root-B")).toBe(true);
    } finally {
      children.forEach((child) => {
        child.finish();
      });
      await foreground;
      await registry.dispose();
      await Promise.all([childLease.release(), primaryLease.release()]);
      await composition.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["full-access", "session-rule"] as const)(
    "resolves %s child ancestry across runs and retains the real sandbox until confirmed",
    async (approvalMode) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "c3-composition-")),
      );
      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      const sessions = createInMemorySessionManager({
        bus,
        messageCleaner: messageManager,
      });
      const primary = await sessions.create(root, {
        id: "primary",
        agentName: "build",
      });
      const other = await sessions.create(root, {
        id: "other",
        agentName: "build",
      });
      const childSession = await sessions.create(root, {
        id: "child",
        parentId: primary.id,
        agentName: "build",
      });
      const sandbox = createHostLocalSandboxManager(root);
      const permissionState = createPermissionState({
        bus,
        initialLevel:
          approvalMode === "full-access" ? "full-access" : "default",
      });
      if (approvalMode === "session-rule") {
        for (const sessionId of [
          primary.id,
          other.id,
          childSession.id,
          "new-child",
        ]) {
          permissionState.addSessionRule(sessionId, {
            tool: "bash",
            decision: "allow",
            scope: "session",
          });
        }
      }
      const ask = vi.fn(() => Promise.resolve("reject" as const));
      const executions = new InMemorySubagentExecutionStore();
      const bindExecution = async (
        childSessionId: string,
        runId: string,
      ): Promise<void> => {
        const executionId = `${childSessionId}-${runId}`;
        await executions.accept({
          executionId,
          rootRunId: `root-${runId}`,
          rootSessionId: primary.id,
          requestId: executionId,
          requesterRunId: `root-${runId}`,
          requesterScopeId: "primary",
          parentSessionId: primary.id,
          subagentId: "child-scope",
          mode: "background",
          prompt: executionId,
          createdAt: 1,
        });
        const lookup = { executionId, parentSessionId: primary.id };
        await executions.bindChild(
          lookup,
          { sessionId: childSessionId, contextScopeId: "child-scope" },
          2,
        );
        await executions.start(lookup, runId, 3);
      };
      await bindExecution(childSession.id, "old-run");
      const composition = await createUiRuntimeComposition({
        bus,
        messageManager,
        sessionManager: sessions,
        subagentExecutionStore: executions,
        sandboxManager: sandbox,
        workdir: root,
        llmClient: unusedLlmClient(),
        permissionState,
        permission: { ask },
        mcpManager: { getAllTools: () => Promise.resolve([]) },
        goalExecutionControl: {
          interruptGoalExecution: () => Promise.resolve(),
        },
        skillRegistry: new SkillRegistry({
          loader: {
            loadContent: (): Promise<never> =>
              Promise.reject(new Error("No skills loaded")),
            scan: (): Promise<Map<string, never>> =>
              Promise.resolve(new Map<string, never>()),
          },
        }),
      });
      const lease = await sandbox.acquire({
        sessionId: childSession.id,
        contextScopeId: "child-scope",
      });
      const otherLease = await sandbox.acquire(other.id);
      const children: Child[] = [];
      const killTree = vi.fn(() =>
        Promise.reject(new Error("injected termination failure")),
      );
      const registry = new ShellJobRegistry({
        killTree,
        probeTree: (child): "stopped" | "running" =>
          (child as unknown as Child).stopped ? "stopped" : "running",
      });
      const owners: ToolExecutionOwner[] = [];
      const bash = createBashTool({
        registry,
        shell: { acceptable: () => "/bin/sh", killTree },
        preflight: () => Promise.resolve({ cdTargets: [], resolvedPaths: [] }),
        spawn: () => {
          const child = new Child();
          children.push(child);
          return child as unknown as ChildProcess;
        },
      });
      const execute = bash.execute.bind(bash);
      vi.spyOn(bash, "execute").mockImplementation((params, context) => {
        if (context.owner) owners.push(context.owner);
        return execute(params, context);
      });
      composition.toolScheduler.unregister("bash");
      composition.toolScheduler.register(bash);
      const request = (
        callId: string,
        overrides: Partial<ToolCallRequest> = {},
      ): ToolCallRequest => ({
        callId,
        sessionId: childSession.id,
        contextScopeId: "child-scope",
        runId: "old-run",
        messageId: "message",
        toolName: "bash",
        environment: lease,
        params: { command: "echo fixture" },
        ...overrides,
      });
      const controller = new AbortController();
      const running = composition.toolScheduler.execute(
        request("old-child", { signal: controller.signal }),
      );
      let destroying: Promise<void> | undefined;
      try {
        await expect.poll(() => children.length).toBe(1);
        expect(owners[0]).toMatchObject({
          sessionId: childSession.id,
          rootSessionId: primary.id,
          runId: "old-run",
          rootRunId: "root-old-run",
          executionId: "child-old-run",
          contextScopeId: "child-scope",
          scopeKey: lease.scopeKey,
        });
        controller.abort();
        expect((await running).status).toBe("cancelled");
        await lease.release();
        let destroyed = false;
        destroying = sandbox
          .destroyContext({
            sessionId: childSession.id,
            contextScopeId: "child-scope",
          })
          .then(() => {
            destroyed = true;
          });
        const independent = await composition.toolScheduler.execute(
          request("other-root", {
            sessionId: other.id,
            contextScopeId: undefined,
            environment: otherLease,
            params: { command: "echo other", run_in_background: true },
          }),
        );
        expect(independent.status).toBe("success");
        expect(destroyed).toBe(false);
        const newChild = await sessions.create(root, {
          id: "new-child",
          parentId: primary.id,
          agentName: "build",
        });
        await bindExecution(childSession.id, "new-run");
        await bindExecution(newChild.id, "new-run");
        for (const sessionId of [primary.id, childSession.id, newChild.id]) {
          const rejected = await composition.toolScheduler.execute(
            request(`blocked-${sessionId}`, { sessionId, runId: "new-run" }),
          );
          expect(rejected.error?.message).toContain("unconfirmed");
        }
        expect(children).toHaveLength(2);
        expect(killTree).toHaveBeenCalledTimes(1);
        children[0].finish();
        await destroying;
        expect(destroyed).toBe(true);
        const rootLease = await sandbox.acquire(primary.id);
        try {
          const resumed = await composition.toolScheduler.execute(
            request("resumed", {
              sessionId: primary.id,
              contextScopeId: undefined,
              environment: rootLease,
              runId: "new-run",
              params: { command: "echo resumed", run_in_background: true },
            }),
          );
          expect(resumed.status).toBe("success");
          expect(children).toHaveLength(3);
          expect(ask).not.toHaveBeenCalled();
        } finally {
          await rootLease.release();
        }
      } finally {
        children.forEach((child) => {
          child.finish();
        });
        await running;
        await registry.dispose();
        await Promise.all([lease.release(), otherLease.release()]);
        await destroying;
        await composition.dispose();
        vi.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
