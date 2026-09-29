import { describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import { createPermissionState } from "../permission/index.js";
import { createToolScheduler } from "../core/tool-scheduler/scheduler.js";
import { ToolSchedulerEvent } from "../core/tool-scheduler/events.js";
import { trustedToolAdmission } from "../core/tool-scheduler/tool-admission.js";
import {
  acquireResources,
  type ResourceLease,
} from "../core/tool-scheduler/resources.js";
import type {
  Tool,
  ToolExecutionContext,
} from "../core/tool-scheduler/types.js";
import {
  createTodoTools,
  TodoService,
  TodoWorkScopeRegistry,
  type TodoWorkScopeId,
} from "./todo.js";

const todos = [{ content: "belongs to A", status: "pending" }] as const;
const context: ToolExecutionContext = {
  callId: "scope-race",
  sessionId: "scope-session",
  messageId: "message",
  signal: new AbortController().signal,
};
const request = {
  callId: context.callId,
  sessionId: context.sessionId,
  messageId: context.messageId,
  toolName: "todo_write",
  params: { todos },
};

async function lockScope(
  tool: Tool,
  scopes: TodoWorkScopeRegistry,
  scope: TodoWorkScopeId,
): Promise<ResourceLease> {
  scopes.acquire(context.sessionId, scope);
  const accesses = await trustedToolAdmission(tool)?.plan?.(
    request.params,
    context,
  );
  if (!accesses)
    throw new Error("Todo tool did not declare its scope resources");
  return acquireResources(accesses);
}

function setup(onWait?: () => void): {
  bus: ReturnType<typeof createBus>;
  scheduler: ReturnType<typeof createToolScheduler>;
  store: TodoService;
  scopes: TodoWorkScopeRegistry;
  writeTool: Tool;
} {
  const bus = createBus();
  const scopes = new TodoWorkScopeRegistry();
  const store = new TodoService();
  const writeTool = createTodoTools(store, {
    resolveWorkScopeId: (ctx) => scopes.resolve(ctx.sessionId),
  }).find((tool) => tool.name === "todo_write");
  if (!writeTool) throw new Error("Missing todo_write fixture");
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact(fact): void {
      if (fact.owner.callId === context.callId && fact.reason === "resource")
        onWait?.();
    },
  });
  scheduler.register(writeTool);
  return { bus, scheduler, store, scopes, writeTool };
}

describe("Todo scope identity through resource admission", () => {
  it("does not follow a changed work scope after invocation while that scope is locked by another owner", async () => {
    const f = setup();
    const lockedB = await lockScope(f.writeTool, f.scopes, "goal:B");
    f.scopes.acquire(context.sessionId, "goal:A");
    f.bus.subscribe(ToolSchedulerEvent.ExecutionStarted, () => {
      f.scopes.acquire(context.sessionId, "goal:B");
    });
    const running = f.scheduler.execute(request);
    try {
      const result = await running;
      expect(result).toMatchObject({
        status: "success",
        metadata: { internalWorkScopeId: "goal:A" },
      });
      expect(
        await f.store.read(context.sessionId, undefined, "goal:A"),
      ).toEqual(todos);
      expect(
        await f.store.read(context.sessionId, undefined, "goal:B"),
      ).toEqual([]);
    } finally {
      lockedB.release();
      f.scheduler.cancelAll();
      await running;
      f.scopes.dispose();
      f.store.dispose();
    }
  });

  it("keeps its resolved scope while waiting for that scope's resource lease", async () => {
    let resolveWaiting: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
    const f = setup(resolveWaiting);
    const lockedA = await lockScope(f.writeTool, f.scopes, "goal:A");
    const lockedB = await lockScope(f.writeTool, f.scopes, "goal:B");
    f.scopes.acquire(context.sessionId, "goal:A");
    const running = f.scheduler.execute(request);
    try {
      await waiting;
      f.scopes.acquire(context.sessionId, "goal:B");
      lockedA.release();
      // B deliberately remains owned until finally: an A invocation cannot
      // migrate to B, either in the wrapper or in TodoService.write.
      await vi.waitFor(() => {
        expect(f.scheduler.getStatus(context.callId)).toBe("success");
      });
      expect(await running).toMatchObject({
        status: "success",
        metadata: { internalWorkScopeId: "goal:A" },
      });
      expect(
        await f.store.read(context.sessionId, undefined, "goal:A"),
      ).toEqual(todos);
      expect(
        await f.store.read(context.sessionId, undefined, "goal:B"),
      ).toEqual([]);
    } finally {
      lockedA.release();
      lockedB.release();
      f.scheduler.cancelAll();
      await running;
      f.scopes.dispose();
      f.store.dispose();
    }
  });
});
