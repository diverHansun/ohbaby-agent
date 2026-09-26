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
import type { ToolExecutionOwner } from "../../core/tool-scheduler/types.js";
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

describe("composition resource admission across real sessions", () => {
  it("shares one scheduler across roots and a child while retaining a canceled write's sandbox until settlement", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-composition-")),
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
    const child = await sessions.create(root, {
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
    const primaryLease = await sandbox.acquire(primary.id);
    const otherLease = await sandbox.acquire(other.id);
    const childLease = await sandbox.acquire({
      sessionId: child.id,
      contextScopeId: "child-scope",
    });
    const owners = new Map<string, ToolExecutionOwner | undefined>();
    for (const name of ["read", "write"]) {
      const tool = composition.toolScheduler.get(name);
      if (!tool) throw new Error(`Missing ${name}`);
      const execute = tool.execute.bind(tool);
      vi.spyOn(tool, "execute").mockImplementation((params, context) => {
        owners.set(context.callId, context.owner);
        return execute(params, context);
      });
    }
    let release = (): void => {
      throw new Error("Gate was not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const target = path.join(root, "shared.txt");
    await fs.writeFile(target, "before\n");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === target) {
        entered = true;
        await gate;
      }
      await rename(from, to);
    });
    const controller = new AbortController();
    const write = composition.toolScheduler.execute({
      sessionId: primary.id,
      callId: "write-primary",
      messageId: "message-primary",
      runId: "run-primary",
      toolName: "write",
      environment: primaryLease,
      signal: controller.signal,
      params: {
        file_path: target,
        content: "after\n",
        expected_mtime_ms: (await fs.stat(target)).mtimeMs,
      },
    });
    let read: ReturnType<typeof composition.toolScheduler.execute> | undefined;
    let destroying: Promise<void> | undefined;
    try {
      await expect.poll(() => entered).toBe(true);
      read = composition.toolScheduler.execute({
        sessionId: child.id,
        contextScopeId: "child-scope",
        callId: "read-child",
        messageId: "message-child",
        runId: "run-child",
        toolName: "read",
        environment: childLease,
        params: { file_path: target },
      });
      await expect
        .poll(() => composition.toolScheduler.getStatus("read-child"))
        .toBe("queued");
      const independent = await composition.toolScheduler.execute({
        sessionId: other.id,
        callId: "write-other",
        messageId: "message-other",
        runId: "run-other",
        toolName: "write",
        environment: otherLease,
        params: {
          file_path: path.join(root, "independent.txt"),
          content: "independent\n",
        },
      });
      expect(independent.status).toBe("success");
      expect(
        await fs.readFile(path.join(root, "independent.txt"), "utf8"),
      ).toBe("independent\n");
      expect(await fs.readFile(target, "utf8")).toBe("before\n");
      expect(owners.has("read-child")).toBe(false);
      expect(owners.get("write-primary")).toMatchObject({
        sessionId: primary.id,
        rootSessionId: primary.id,
        scopeKey: primaryLease.scopeKey,
        runId: "run-primary",
        messageId: "message-primary",
        callId: "write-primary",
      });
      expect(owners.get("write-other")).toMatchObject({
        sessionId: other.id,
        rootSessionId: other.id,
        scopeKey: otherLease.scopeKey,
      });
      expect(owners.get("write-other")?.runtimeGeneration).toBe(
        owners.get("write-primary")?.runtimeGeneration,
      );
      expect(owners.get("write-primary")?.runtimeGeneration).toEqual(
        expect.any(String),
      );
      controller.abort();
      expect((await write).status).toBe("cancelled");
      await primaryLease.release();
      let destroyed = false;
      destroying = sandbox
        .destroyContext({ sessionId: primary.id })
        .then(() => {
          destroyed = true;
        });
      // A fresh unrelated operation gives the real sandbox drain a scheduling turn.
      const otherRead = await composition.toolScheduler.execute({
        sessionId: other.id,
        callId: "read-other",
        messageId: "message-other",
        toolName: "read",
        environment: otherLease,
        params: { file_path: path.join(root, "independent.txt") },
      });
      expect(otherRead.status).toBe("success");
      expect(destroyed).toBe(false);
      expect(owners.has("read-child")).toBe(false);
      release();
      const childResult = await read;
      expect(childResult.status).toBe("success");
      expect(childResult.output).toContain("after");
      expect(owners.get("read-child")).toMatchObject({
        sessionId: child.id,
        rootSessionId: primary.id,
        contextScopeId: "child-scope",
        scopeKey: childLease.scopeKey,
      });
      await destroying;
      expect(destroyed).toBe(true);
    } finally {
      release();
      await Promise.allSettled([write, ...(read ? [read] : [])]);
      await Promise.all([
        primaryLease.release(),
        otherLease.release(),
        childLease.release(),
      ]);
      await destroying;
      await composition.dispose();
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
