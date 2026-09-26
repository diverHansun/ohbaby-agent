import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
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
  it("resolves full-access child ancestry across runs and retains the real sandbox until confirmed", async () => {
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
    const composition = await createUiRuntimeComposition({
      bus,
      messageManager,
      sessionManager: sessions,
      sandboxManager: sandbox,
      workdir: root,
      llmClient: unusedLlmClient(),
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      mcpManager: { getAllTools: () => Promise.resolve([]) },
      goalExecutionControl: { interruptGoalExecution: () => Promise.resolve() },
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
  });
});
