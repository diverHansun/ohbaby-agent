import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { AgentManager } from "../../../packages/ohbaby-agent/src/agents/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { createInMemorySessionManager } from "../../../packages/ohbaby-agent/src/services/session/index.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
  type PermissionInfo,
} from "../../../packages/ohbaby-agent/src/permission/index.js";
import { createUiRuntimeComposition } from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.js";
import type { InterfaceProviderStreamEvent } from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import { SkillRegistry } from "../../../packages/ohbaby-agent/src/skill/index.js";
import { ToolSchedulerEvent } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/events.js";
import type { ToolCallResult } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/types.js";

function tool(
  name: string,
  params: Record<string, unknown>,
  id: string,
): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      { index: 0, id, name, argumentsDelta: JSON.stringify(params) },
    ],
  };
}

async function fixture(delegate: boolean, childTimeoutMs?: number) {
  const bus = createBus();
  const permissionState = createPermissionState({ bus });
  const permission = createPermissionManager({ bus, state: permissionState });
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const sessionManager = createInMemorySessionManager({
    bus,
    createSessionId: () => "child",
    messageCleaner: messageManager,
  });
  let primaryStep = 0;
  let childStep = 0;
  const llmClient: LLMClientInstance = {
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      provider: "openai",
      temperature: 0,
    },
    provider: {
      client: {},
      id: "fake",
      kind: "openai-compatible",
      isAbortError: () => false,
      async streamResponse(request) {
        const child = JSON.stringify(request.messages).includes(
          "Task: generic",
        );
        const step = child ? childStep++ : primaryStep++;
        const event =
          step > 0
            ? {
                finishReason: "stop" as const,
                textDelta: child ? "child complete" : "parent complete",
              }
            : delegate && !child
              ? tool(
                  "subagent_run",
                  {
                    role: "generic",
                    prompt: "Run one harmless bash command",
                    mode: "foreground",
                    description: "Permission child",
                    ...(childTimeoutMs === undefined
                      ? {}
                      : { timeout_ms: childTimeoutMs }),
                  },
                  "delegate_call",
                )
              : tool(
                  "bash",
                  {
                    command:
                      "node -e \"process.stdout.write('permission-lifecycle')\"",
                  },
                  child ? "child_call" : "primary_call",
                );
        return (async function* () {
          yield event;
        })();
      },
    },
  };
  const composition = await createUiRuntimeComposition({
    agentManager: new AgentManager(),
    bus,
    llmClient,
    messageManager,
    sessionManager,
    permissionManager: permission,
    permissionState,
    goalExecutionControl: { interruptGoalExecution: async () => {} },
    skillRegistry: new SkillRegistry({
      loader: {
        loadContent: async () => {
          throw new Error("No skills");
        },
        scan: async () => new Map(),
      },
    }),
    workdir: process.cwd(),
  });
  return { bus, composition, permission, messageManager };
}

describe("permission actual run lifecycle", () => {
  it.each([false, true])(
    "keeps the actual %s source and run through approval and completion",
    async (delegate) => {
      const f = await fixture(delegate);
      const requests: PermissionInfo[] = [];
      f.bus.subscribe(PermissionEvent.Updated, ({ info }) => {
        requests.push(info);
        f.permission.respond(info.sessionId, info.id, { type: "once" });
      });
      try {
        const run = await f.composition.startSession({
          agentName: "build",
          projectRoot: process.cwd(),
          sessionId: "root",
          prompt: "Run the permission test",
        });
        const completion = await f.composition.runManager.waitForCompletion(
          run.runId,
        );
        expect(completion).toMatchObject({
          status: "succeeded",
          finalResponse: "parent complete",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          sessionId: delegate ? "child" : "root",
          rootSessionId: "root",
          callId: delegate ? "child_call" : "primary_call",
        });
        expect(requests[0].runId).toBeTruthy();
        if (delegate) expect(requests[0].runId).not.toBe(run.runId);
        else expect(requests[0].runId).toBe(run.runId);
        expect(f.permission.listPending()).toEqual([]);
      } finally {
        await f.composition.dispose();
      }
    },
  );

  it("revokes a real child approval when its primary execution is interrupted", async () => {
    const f = await fixture(true);
    let received!: (info: PermissionInfo) => void;
    const requested = new Promise<PermissionInfo>((resolve) => {
      received = resolve;
    });
    f.bus.subscribe(PermissionEvent.Updated, ({ info }) => received(info));
    try {
      const run = await f.composition.startSession({
        agentName: "build",
        projectRoot: process.cwd(),
        sessionId: "root",
        prompt: "Run the permission test",
      });
      const info = await requested;
      await f.composition.interruptRunTree(run.runId, "test interruption");
      await f.composition.runManager.waitForCompletion(run.runId);
      expect(f.permission.listPending()).toEqual([]);
      expect(
        f.permission.respond(info.sessionId, info.id, { type: "always" }),
      ).toBe("revoked");
      expect(f.permission.state.getSessionRules(info.sessionId)).toEqual([]);
    } finally {
      await f.composition.dispose();
    }
  });
});

it("pauses a real child quota during pure approval waiting but still obeys root interruption", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = await fixture(true, 50);
  let receive!: (info: PermissionInfo) => void;
  const requested = new Promise<PermissionInfo>((resolve) => {
    receive = resolve;
  });
  f.bus.subscribe(PermissionEvent.Updated, ({ info }) => receive(info));
  try {
    const run = await f.composition.startSession({
      agentName: "build",
      projectRoot: process.cwd(),
      sessionId: "root",
      prompt: "Run the permission test",
    });
    const request = await requested;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.permission.listPending()).toHaveLength(1);
    expect(f.composition.runManager.get(request.runId)?.status).toBe("running");
    expect(f.composition.runManager.get(run.runId)?.status).toBe("running");
    await f.composition.interruptRunTree(
      run.runId,
      "stop during approval pause",
    );
    await f.composition.runManager.waitForCompletion(run.runId);
    expect(f.permission.listPending()).toEqual([]);
    expect(
      f.permission.respond(request.sessionId, request.id, { type: "always" }),
    ).toBe("revoked");
    expect(f.permission.state.getSessionRules(request.sessionId)).toEqual([]);
    expect(f.composition.runManager.get(request.runId)?.status).toBe(
      "interrupted",
    );
  } finally {
    await f.composition.dispose();
    vi.useRealTimers();
  }
});

it("cancels and revokes the actual run when the coordinator returns an unexpected identity", async () => {
  const f = await fixture(false);
  let receive!: (info: PermissionInfo) => void;
  const requested = new Promise<PermissionInfo>((resolve) => {
    receive = resolve;
  });
  f.bus.subscribe(PermissionEvent.Updated, ({ info }) => receive(info));
  const create = f.composition.runManager.create.bind(f.composition.runManager);
  vi.spyOn(f.composition.runManager, "create").mockImplementation(
    async (options) => {
      const actual = await create({
        ...options,
        runId: "unexpected_actual_run",
      });
      await requested;
      return actual;
    },
  );
  try {
    await expect(
      f.composition.startSession({
        agentName: "build",
        projectRoot: process.cwd(),
        sessionId: "root",
        prompt: "Run the permission test",
      }),
    ).rejects.toThrow("unexpected run id");
    const request = await requested;
    expect(request.runId).toBe("unexpected_actual_run");
    await f.composition.runManager.waitForCompletion(request.runId);
    expect(f.composition.runManager.get(request.runId)?.status).toBe(
      "interrupted",
    );
    expect(f.permission.listPending()).toEqual([]);
    expect(
      f.permission.respond(request.sessionId, request.id, { type: "always" }),
    ).toBe("revoked");
    expect(f.permission.state.getSessionRules(request.sessionId)).toEqual([]);
  } finally {
    await f.composition.dispose();
  }
});

it("closes a foreground child wait before approval or execution when child run ownership mismatches", async () => {
  const f = await fixture(true);
  const requests: PermissionInfo[] = [];
  const started = vi.fn();
  let rejectCall!: (result: ToolCallResult) => void;
  const rejected = new Promise<ToolCallResult>((resolve) => {
    rejectCall = resolve;
  });
  f.bus.subscribe(PermissionEvent.Updated, ({ info }) => requests.push(info));
  f.bus.subscribe(ToolSchedulerEvent.ExecutionStarted, (event) => {
    if (event.toolName === "bash") started();
  });
  f.bus.subscribe(ToolSchedulerEvent.ExecutionCompleted, (event) => {
    if (event.callId === "child_call") rejectCall(event.result);
  });
  const create = f.composition.runManager.create.bind(f.composition.runManager);
  vi.spyOn(f.composition.runManager, "create").mockImplementation(
    async (options) => {
      if (!options.isSubagent) return create(options);
      const actual = await create({
        ...options,
        runId: "unexpected_child_run",
      });
      // Unknown child-run ownership is rejected before approval can be requested.
      await rejected;
      return actual;
    },
  );
  try {
    const parent = await f.composition.startSession({
      agentName: "build",
      projectRoot: process.cwd(),
      sessionId: "root",
      prompt: "Run the permission test",
    });
    expect(await rejected).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("execution ownership") },
    });
    await f.composition.runManager.waitForCompletion(parent.runId);
    await f.composition.runManager.waitForCompletion("unexpected_child_run");
    expect(f.composition.runManager.get("unexpected_child_run")?.status).toBe(
      "interrupted",
    );
    expect(
      JSON.stringify(await f.messageManager.listBySession("root")),
    ).toContain("unexpected run id");
    expect(requests).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(f.permission.listPending()).toEqual([]);
    expect(f.permission.state.getSessionRules("child")).toEqual([]);
  } finally {
    await f.composition.dispose();
  }
});
