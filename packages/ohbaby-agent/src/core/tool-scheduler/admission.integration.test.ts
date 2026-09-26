import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createHostLocalEnvironment } from "../../adapters/ui-runtime/host-local-environment.js";
import { createBuiltinTools } from "../../tools/builtin.js";
import { createToolScheduler } from "./scheduler.js";
import { withToolAdmission } from "./tool-admission.js";
import type { ResourceAccess } from "./resources.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(): ReturnType<typeof createToolScheduler> {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  for (const tool of createBuiltinTools()) scheduler.register(tool);
  return scheduler;
}
describe("C2 resource admission", () => {
  it("allows an independent file write in the same batch while the first write is still active", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-admission-")),
    );
    const scheduler = fixture();
    const gate = deferred();
    const entered = deferred();
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, "a.txt")) {
        entered.resolve();
        await gate.promise;
      }
      await rename(from, to);
    });
    const batch = scheduler.executeBatch({
      calls: ["a", "b"].map((id) => ({
        callId: id,
        sessionId: "s",
        messageId: "m",
        toolName: "write",
        params: { file_path: `${id}.txt`, content: id },
        environment: createHostLocalEnvironment(root),
      })),
    });
    try {
      await entered.promise;
      await expect
        .poll(
          async () =>
            fs
              .readFile(path.join(root, "b.txt"), "utf8")
              .catch(() => "missing"),
          { timeout: 250 },
        )
        .toBe("b");
    } finally {
      gate.resolve();
      await batch;
      spy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

it("releases resources when retaining the execution environment fails before invocation", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "c2-retain-")),
  );
  const scheduler = fixture();
  const environment = createHostLocalEnvironment(root);
  const request = {
    sessionId: "s",
    messageId: "m",
    toolName: "write",
    params: { file_path: "a.txt", content: "ok" },
    environment,
  };
  const controller = new AbortController();
  try {
    const first = await scheduler.execute({
      ...request,
      callId: "bad-retain",
      environment: {
        ...environment,
        retain() {
          throw new Error("released scope");
        },
      },
    });
    expect(first.status).toBe("error");
    const next = scheduler.execute({
      ...request,
      callId: "after-retain",
      signal: controller.signal,
    });
    try {
      await expect
        .poll(
          async () =>
            fs
              .readFile(path.join(root, "a.txt"), "utf8")
              .catch(() => "missing"),
          { timeout: 250 },
        )
        .toBe("ok");
    } finally {
      controller.abort();
      await next;
    }
  } finally {
    scheduler.cancelAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects duplicate call IDs in one concurrent batch before invoking twice", async () => {
  const scheduler = fixture();
  let executes = 0;
  scheduler.register({
    name: "duplicate",
    description: "fixture",
    parametersJsonSchema: {},
    source: "builtin",
    execute() {
      executes += 1;
      return { output: "ok" };
    },
  });
  const call = {
    callId: "duplicate-id",
    toolName: "duplicate",
    sessionId: "s",
    messageId: "m",
    params: {},
  };
  const results = await scheduler.executeBatch({ calls: [call, call] });
  expect(executes).toBe(1);
  expect(results.map((r) => r.error?.type)).toEqual([
    undefined,
    "ValidationError",
  ]);
});

it("waits for an in-flight creation before checking that the read target exists", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "c2-create-read-")),
  );
  const bus = createBus();
  const blocked = deferred();
  const entered = deferred();
  const gate = deferred();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact(f) {
      if (f.owner.callId === "new-read" && f.reason === "resource")
        blocked.resolve();
    },
  });
  for (const tool of createBuiltinTools()) scheduler.register(tool);
  const environment = createHostLocalEnvironment(root);
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === path.join(root, "new.txt")) {
      entered.resolve();
      await gate.promise;
    }
    await rename(from, to);
  });
  const write = scheduler.execute({
    callId: "create",
    toolName: "write",
    sessionId: "s1",
    messageId: "m",
    environment,
    params: { file_path: "new.txt", content: "created" },
  });
  let read: ReturnType<typeof scheduler.execute> | undefined;
  try {
    await entered.promise;
    read = scheduler.execute({
      callId: "new-read",
      toolName: "read",
      sessionId: "s2",
      messageId: "m",
      environment,
      params: { file_path: "new.txt" },
    });
    await Promise.race([
      blocked.promise,
      read.then((r) => {
        throw new Error(
          `Read settled before creation released: ${r.error?.message ?? r.status}`,
        );
      }),
    ]);
    gate.resolve();
    expect((await read).output).toContain("created");
  } finally {
    gate.resolve();
    await Promise.all([write, read]);
    spy.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("starts trusted independent control while a sibling resource plan is pending", async () => {
  const scheduler = fixture();
  const planGate = deferred();
  let controlStarted = false;
  const tool = {
    description: "controlled admission probe",
    source: "builtin" as const,
    category: "readonly" as const,
    parametersJsonSchema: { type: "object" },
    execute: (): { output: string } => ({ output: "ok" }),
  };
  scheduler.register(
    withToolAdmission(
      { ...tool, name: "slow_plan" },
      {
        plan: async () => {
          await planGate.promise;
          return [];
        },
      },
    ),
  );
  scheduler.register(
    withToolAdmission(
      {
        ...tool,
        name: "control",
        execute: () => {
          controlStarted = true;
          return { output: "control available" };
        },
      },
      { capacity: "control", plan: () => [] },
    ),
  );
  const batch = scheduler.executeBatch({
    calls: ["slow_plan", "control"].map((toolName) => ({
      callId: toolName,
      sessionId: "s",
      messageId: "m",
      toolName,
      params: {},
    })),
  });
  try {
    await expect.poll(() => controlStarted, { timeout: 250 }).toBe(true);
  } finally {
    planGate.resolve();
    await batch;
  }
});

it("preserves known scope predecessors while an earlier permission preparation is pending", async () => {
  const gate = deferred();
  const bus = createBus();
  const entered: string[] = [];
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    accessGuard: async ({ request }) => {
      if (request.callId === "first") await gate.promise;
      return undefined;
    },
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "scoped_write",
        description: "scope probe",
        source: "builtin",
        category: "write",
        parametersJsonSchema: { type: "object" },
        execute: (_params, context) => {
          entered.push(context.callId);
          return { output: "ok" };
        },
      },
      { plan: () => [{ kind: "scope", key: "same", mode: "write" }] },
    ),
  );
  const batch = scheduler.executeBatch({
    calls: ["first", "second"].map((callId) => ({
      callId,
      sessionId: "s",
      messageId: "m",
      toolName: "scoped_write",
      params: {},
    })),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toEqual([]);
  } finally {
    gate.resolve();
    await batch;
  }
  expect(entered).toEqual(["first", "second"]);
});

it("waits only for a declared pending plan before deciding scope conflicts", async () => {
  const scheduler = fixture();
  const planGate = deferred();
  const operationGate = deferred();
  const entered: string[] = [];
  const resources = [
    { kind: "scope" as const, key: "async-scope", mode: "write" as const },
  ];
  for (const name of ["first_scope", "second_scope"]) {
    scheduler.register(
      withToolAdmission(
        {
          name,
          source: "builtin",
          category: "write",
          description: "scope probe",
          parametersJsonSchema: { type: "object" },
          execute: async () => {
            entered.push(name);
            if (name === "first_scope") await operationGate.promise;
            return { output: "ok" };
          },
        },
        {
          plan:
            name === "first_scope"
              ? async (): Promise<readonly ResourceAccess[]> => {
                  await planGate.promise;
                  return resources;
                }
              : (): readonly ResourceAccess[] => resources,
        },
      ),
    );
  }
  const batch = scheduler.executeBatch({
    calls: ["first_scope", "second_scope"].map((toolName) => ({
      callId: toolName,
      toolName,
      params: {},
      sessionId: "s",
      messageId: "m",
    })),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toEqual([]);
    planGate.resolve();
    await expect.poll(() => entered).toEqual(["first_scope"]);
  } finally {
    planGate.resolve();
    operationGate.resolve();
    await batch;
  }
  expect(entered).toEqual(["first_scope", "second_scope"]);
});
