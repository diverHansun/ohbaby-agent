import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "../../tools/read.js";
import { createWriteTool } from "../../tools/write.js";
import { createHostLocalEnvironment } from "../../adapters/ui-runtime/host-local-environment.js";
import { acquireResources } from "./resources.js";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "./scheduler.js";
import {
  withToolAdmission,
  independentToolAdmission,
} from "./tool-admission.js";
import type { ToolCallResult, ToolExecutionFact } from "./types.js";

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error("Gate not initialized");
  };
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

describe("cancelable scheduler preparation", () => {
  it.each([
    ["accessGuard", "signal"],
    ["accessGuard", "scheduler"],
    ["agentTools", "signal"],
    ["agentTools", "scheduler"],
  ] as const)(
    "settles %s preparation cancellation via %s before the lookup completes",
    async (stage, cancellation) => {
      const bus = createBus();
      const pending = gate();
      const facts: ToolExecutionFact[] = [];
      let entered = false;
      let executed = 0;
      const scheduler = createToolScheduler({
        bus,
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
        onExecutionFact: (fact) => {
          facts.push(fact);
        },
        ...(stage === "accessGuard"
          ? {
              accessGuard: async (): Promise<undefined> => {
                entered = true;
                await pending.promise;
                return undefined;
              },
            }
          : {
              agentTools: {
                getAgentConfig: async (): Promise<Record<string, never>> => {
                  entered = true;
                  await pending.promise;
                  return {};
                },
              },
            }),
      });
      scheduler.register({
        name: "prepared",
        description: "controlled operation",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: () => {
          executed++;
          return { output: "unexpected" };
        },
      });
      const controller = new AbortController();
      const call = scheduler.execute({
        callId: "pending",
        sessionId: "session",
        messageId: "message",
        toolName: "prepared",
        params: {},
        signal: controller.signal,
      });
      let result: ToolCallResult | undefined;
      const observed = call.then((value) => {
        result = value;
      });
      try {
        await expect.poll(() => entered).toBe(true);
        if (cancellation === "signal") controller.abort();
        else expect(scheduler.cancel("pending")).toBe(true);
        await expect
          .poll(() => result?.status, { timeout: 250 })
          .toBe("cancelled");
        expect(executed).toBe(0);
        expect(facts.filter((f) => f.phase === "started")).toEqual([]);
        expect(result?.duration).toBeUndefined();
        pending.release();
        await observed;
        expect(executed).toBe(0);
      } finally {
        pending.release();
        await observed;
      }
    },
  );

  it.each(["accessGuard", "agentTools"] as const)(
    "an independent batch operation starts while another %s lookup is pending",
    async (stage) => {
      const bus = createBus();
      const pending = gate();
      let entered = false;
      const executed: string[] = [];
      const scheduler = createToolScheduler({
        bus,
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
        ...(stage === "accessGuard"
          ? {
              accessGuard: async ({
                request,
              }: {
                request: { callId: string };
              }): Promise<undefined> => {
                if (request.callId === "blocked") {
                  entered = true;
                  await pending.promise;
                }
                return undefined;
              },
            }
          : {
              agentTools: {
                getAgentConfig: async (
                  agentName?: string,
                ): Promise<Record<string, never>> => {
                  if (agentName === "slow") {
                    entered = true;
                    await pending.promise;
                  }
                  return {};
                },
              },
            }),
      });
      for (const name of ["blocked", "independent"])
        scheduler.register(
          withToolAdmission(
            {
              name,
              description: "independent scoped operation",
              source: "builtin",
              category: "readonly",
              parametersJsonSchema: { type: "object" },
              execute: () => {
                executed.push(name);
                return { output: name };
              },
            },
            independentToolAdmission,
          ),
        );
      const controller = new AbortController();
      const batch = scheduler.executeBatch({
        calls: [
          {
            callId: "blocked",
            agentName: "slow",
            toolName: "blocked",
            sessionId: "session",
            messageId: "message",
            params: {},
            signal: controller.signal,
          },
          {
            callId: "independent",
            agentName: "fast",
            toolName: "independent",
            sessionId: "session",
            messageId: "message",
            params: {},
          },
        ],
      });
      try {
        await expect.poll(() => entered).toBe(true);
        await expect
          .poll(() => executed, { timeout: 250 })
          .toEqual(["independent"]);
        controller.abort();
        const result = await batch;
        expect(result.map((item) => item.status)).toEqual([
          "cancelled",
          "success",
        ]);
        expect(executed).toEqual(["independent"]);
      } finally {
        controller.abort();
        pending.release();
        await batch;
      }
    },
  );
  it.each(["resource", "capacity"] as const)(
    "honors a deny added while an approved write waits for %s",
    async (reason) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "c2-policy-")),
      );
      const target = path.join(root, "target.txt");
      const bus = createBus();
      const permissionState = createPermissionState({
        bus,
        initialLevel: "full-access",
      });
      const facts: ToolExecutionFact[] = [];
      const pending = gate();
      const scheduler = createToolScheduler({
        bus,
        permissionState,
        config: { concurrency: { maxConcurrency: 1 } },
        onExecutionFact: (fact) => {
          facts.push(fact);
        },
      });
      scheduler.register(createWriteTool());
      scheduler.register(
        withToolAdmission(
          {
            name: "hold-capacity",
            description: "controlled capacity holder",
            source: "builtin",
            category: "readonly",
            parametersJsonSchema: { type: "object" },
            async execute() {
              await pending.promise;
              return { output: "released" };
            },
          },
          independentToolAdmission,
        ),
      );
      const lease =
        reason === "resource"
          ? await acquireResources([
              { kind: "file", path: target, scope: "file", mode: "write" },
            ])
          : undefined;
      const holder =
        reason === "capacity"
          ? scheduler.execute({
              callId: "holder",
              sessionId: "session",
              messageId: "message",
              toolName: "hold-capacity",
              params: {},
            })
          : undefined;
      let write: ReturnType<typeof scheduler.execute> | undefined;
      try {
        if (holder)
          await expect
            .poll(() =>
              facts.some(
                (f) => f.owner.callId === "holder" && f.phase === "started",
              ),
            )
            .toBe(true);
        write = scheduler.execute({
          callId: "guarded-write",
          sessionId: "session",
          messageId: "message",
          toolName: "write",
          params: { file_path: target, content: "must not be written" },
          environment: createHostLocalEnvironment(root),
        });
        await expect
          .poll(() =>
            facts.some(
              (f) => f.owner.callId === "guarded-write" && f.reason === reason,
            ),
          )
          .toBe(true);
        permissionState.addSessionRule("session", {
          tool: "write",
          decision: "deny",
          scope: "session",
          reason: "policy revoked while waiting",
        });
        lease?.release();
        pending.release();
        const result = await write;
        expect(result.status).toBe("rejected");
        expect(result.duration).toBeUndefined();
        expect(
          facts.some(
            (f) => f.owner.callId === "guarded-write" && f.phase === "started",
          ),
        ).toBe(false);
        await expect(fs.access(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        lease?.release();
        pending.release();
        await Promise.allSettled([
          ...(holder ? [holder] : []),
          ...(write ? [write] : []),
        ]);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("releases resources and capacity before asking again after Full Access changes during a wait", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-reauthorize-")),
    );
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "before");
    const bus = createBus();
    const state = createPermissionState({ bus, initialLevel: "full-access" });
    const facts: ToolExecutionFact[] = [];
    const approval = gate();
    let asks = 0;
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      config: { concurrency: { maxConcurrency: 1 } },
      permission: {
        async ask(): Promise<"once"> {
          asks++;
          await approval.promise;
          return "once";
        },
      },
      onExecutionFact: (fact) => {
        facts.push(fact);
      },
    });
    scheduler.register(createWriteTool());
    scheduler.register(createReadTool());
    const environment = createHostLocalEnvironment(root);
    const holder = await acquireResources([
      { kind: "file", path: target, scope: "file", mode: "write" },
    ]);
    const write = scheduler.execute({
      callId: "writer",
      runId: "run",
      messageId: "message",
      sessionId: "session",
      toolName: "write",
      params: {
        file_path: target,
        content: "after",
        expected_mtime_ms: (await fs.stat(target)).mtimeMs,
      },
      environment,
    });
    try {
      await expect
        .poll(() =>
          facts.some(
            (f) => f.owner.callId === "writer" && f.reason === "resource",
          ),
        )
        .toBe(true);
      state.setLevel("default");
      holder.release();
      await expect.poll(() => asks).toBe(1);
      const read = scheduler.execute({
        callId: "reader",
        messageId: "message",
        sessionId: "session",
        toolName: "read",
        params: { file_path: target },
        environment,
      });
      let readResult: ToolCallResult | undefined;
      const observed = read.then((result) => {
        readResult = result;
      });
      try {
        await expect.poll(() => readResult?.status).toBe("success");
        expect(readResult?.output).toContain("before");
        expect(
          facts.some(
            (f) => f.owner.callId === "writer" && f.phase === "started",
          ),
        ).toBe(false);
      } finally {
        approval.release();
        await observed;
      }
      expect((await write).status).toBe("success");
      expect(await fs.readFile(target, "utf8")).toBe("after");
    } finally {
      holder.release();
      approval.release();
      await write;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("asks again when a symlink moves to another workspace target while its first approval is pending", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-retarget-")),
    );
    for (const folder of ["old", "new"])
      await fs.mkdir(path.join(root, folder));
    const link = path.join(root, "link");
    await fs.symlink(path.join(root, "old"), link);
    const bus = createBus();
    const state = createPermissionState({ bus });
    const approvals = [gate(), gate()];
    let asks = 0;
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      permission: {
        async ask(): Promise<"once"> {
          if (asks >= approvals.length)
            throw new Error("Unexpected extra approval");
          const pending = approvals[asks++];
          await pending.promise;
          return "once";
        },
      },
    });
    scheduler.register(createWriteTool());
    const write = scheduler.execute({
      callId: "retarget",
      runId: "run",
      messageId: "message",
      sessionId: "session",
      toolName: "write",
      params: { file_path: path.join(link, "file.txt"), content: "new-target" },
      environment: createHostLocalEnvironment(root),
    });
    try {
      await expect.poll(() => asks).toBe(1);
      await fs.unlink(link);
      await fs.symlink(path.join(root, "new"), link);
      approvals[0]?.release();
      await expect.poll(() => asks).toBe(2);
      await expect(
        fs.access(path.join(root, "old", "file.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(root, "new", "file.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      approvals[1]?.release();
      expect((await write).status).toBe("success");
      expect(
        await fs.readFile(path.join(root, "new", "file.txt"), "utf8"),
      ).toBe("new-target");
      await expect(
        fs.access(path.join(root, "old", "file.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const approval of approvals) approval.release();
      await write;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rechecks a policy change during post-approval target validation instead of stamping it as already approved", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-policy-revalidate-")),
    );
    const target = path.join(root, "target.txt");
    const bus = createBus();
    const state = createPermissionState({ bus, initialLevel: "full-access" });
    const validation = gate();
    let lookups = 0;
    let validationWaiting = false;
    let asks = 0;
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]) === target && ++lookups === 2) {
        validationWaiting = true;
        await validation.promise;
      }
      return await realpath(...args);
    });
    const scheduler = createToolScheduler({
      bus,
      permissionState: state,
      permission: {
        ask: () => {
          asks++;
          return Promise.resolve("reject");
        },
      },
    });
    scheduler.register(createWriteTool());
    const write = scheduler.execute({
      callId: "policy-race",
      runId: "run",
      sessionId: "session",
      messageId: "message",
      toolName: "write",
      params: { file_path: target, content: "unauthorized" },
      environment: createHostLocalEnvironment(root),
    });
    try {
      await expect.poll(() => validationWaiting).toBe(true);
      state.setLevel("default");
      validation.release();
      const result = await write;
      expect(asks).toBe(1);
      expect(result.status).toBe("rejected");
      expect(result.duration).toBeUndefined();
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      validation.release();
      await write;
      spy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
