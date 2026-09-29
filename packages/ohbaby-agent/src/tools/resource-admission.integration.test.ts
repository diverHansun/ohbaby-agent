import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import { createPermissionState } from "../permission/index.js";
import { createHostLocalEnvironment } from "../adapters/ui-runtime/host-local-environment.js";
import { createToolScheduler } from "../core/tool-scheduler/scheduler.js";
import { acquireResources } from "../core/tool-scheduler/resources.js";
import type {
  ToolCallRequest,
  ToolExecutionFact,
  ToolExecutionContext,
  Tool,
} from "../core/tool-scheduler/types.js";
import { createBuiltinTools } from "./builtin.js";
import { createWriteTool } from "./write.js";
import { InMemoryTodoStore, type TodoStore } from "./todo.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error("Uninitialized gate");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(todoStore?: TodoStore): {
  scheduler: ReturnType<typeof createToolScheduler>;
  facts: ToolExecutionFact[];
} {
  const bus = createBus();
  const facts: ToolExecutionFact[] = [];
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact: (fact) => {
      facts.push(fact);
    },
  });
  for (const tool of createBuiltinTools({ todoStore }))
    scheduler.register(tool);
  return { scheduler, facts };
}

describe("builtin shared resource admission", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-resources-")),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  function request(
    callId: string,
    toolName: string,
    params: Record<string, unknown>,
    sessionId = "session",
  ): ToolCallRequest {
    return {
      callId,
      toolName,
      params,
      sessionId,
      messageId: "message",
      environment: createHostLocalEnvironment(root),
    };
  }
  function context(callId: string): ToolExecutionContext {
    return {
      callId,
      sessionId: "direct",
      messageId: "message",
      signal: new AbortController().signal,
      environment: createHostLocalEnvironment(root),
    };
  }

  it("a direct builtin write excludes a scheduled read until atomic replacement settles", async () => {
    const { scheduler, facts } = fixture();
    const target = path.join(root, "shared.txt");
    await fs.writeFile(target, "before\n");
    const gate = deferred();
    let entered = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === target) {
        entered = true;
        await gate.promise;
      }
      await rename(from, to);
    });
    const direct = Promise.resolve(
      createWriteTool().execute(
        {
          file_path: target,
          content: "after\n",
          expected_mtime_ms: (await fs.stat(target)).mtimeMs,
        },
        context("direct"),
      ),
    );
    let reader: ReturnType<typeof scheduler.execute> | undefined;
    try {
      await expect.poll(() => entered).toBe(true);
      reader = scheduler.execute(
        request("reader", "read", { file_path: target }),
      );
      await expect
        .poll(() =>
          facts.some(
            (f) => f.owner.callId === "reader" && f.reason === "resource",
          ),
        )
        .toBe(true);
      expect(
        facts.some((f) => f.owner.callId === "reader" && f.phase === "started"),
      ).toBe(false);
      expect(await fs.readFile(target, "utf8")).toBe("before\n");
      gate.resolve();
      await direct;
      const result = await reader;
      expect(result.status).toBe("success");
      expect(result.output).toContain("after");
    } finally {
      gate.resolve();
      await Promise.allSettled([direct, ...(reader ? [reader] : [])]);
    }
  });

  it("different schedulers serialize writes through a symlink alias of one target", async () => {
    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "alias"));
    const target = path.join(root, "real", "shared.txt");
    await fs.writeFile(target, "old\n");
    const first = fixture();
    const second = fixture();
    const gate = deferred();
    let entered = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === target && !entered) {
        entered = true;
        await gate.promise;
      }
      await rename(from, to);
    });
    const write = first.scheduler.execute(
      request(
        "write",
        "write",
        {
          file_path: target,
          content: "new\n",
          expected_mtime_ms: (await fs.stat(target)).mtimeMs,
        },
        "first",
      ),
    );
    let edit: ReturnType<typeof second.scheduler.execute> | undefined;
    try {
      await expect.poll(() => entered).toBe(true);
      edit = second.scheduler.execute(
        request(
          "edit",
          "edit",
          {
            file_path: "alias/shared.txt",
            old_string: "new",
            new_string: "final",
          },
          "second",
        ),
      );
      await expect
        .poll(() => second.facts.some((f) => f.reason === "resource"))
        .toBe(true);
      gate.resolve();
      expect((await write).status).toBe("success");
      expect((await edit).status).toBe("success");
      expect(await fs.readFile(target, "utf8")).toBe("final\n");
    } finally {
      gate.resolve();
      await Promise.allSettled([write, ...(edit ? [edit] : [])]);
    }
  });

  it("readers share a file while a later writer waits for both read operations", async () => {
    const { scheduler, facts } = fixture();
    const target = path.join(root, "readers.txt");
    await fs.writeFile(target, "before\n");
    const gate = deferred();
    let readers = 0;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === target) {
        readers++;
        await gate.promise;
      }
      return await open(...args);
    });
    const first = scheduler.execute(
      request("read1", "read", { file_path: target }),
    );
    const second = scheduler.execute(
      request("read2", "read", { file_path: target }),
    );
    let write: ReturnType<typeof scheduler.execute> | undefined;
    try {
      await expect.poll(() => readers).toBe(2);
      write = scheduler.execute(
        request("write", "write", {
          file_path: target,
          content: "after\n",
          expected_mtime_ms: (await fs.stat(target)).mtimeMs,
        }),
      );
      await expect
        .poll(() =>
          facts.some(
            (f) => f.owner.callId === "write" && f.reason === "resource",
          ),
        )
        .toBe(true);
      gate.resolve();
      for (const result of await Promise.all([first, second])) {
        expect(result.status).toBe("success");
        expect(result.output).toContain("before");
      }
      expect((await write).status).toBe("success");
      expect(await fs.readFile(target, "utf8")).toBe("after\n");
    } finally {
      gate.resolve();
      await Promise.allSettled([first, second, ...(write ? [write] : [])]);
    }
  });

  it.each(["list", "glob", "grep"] as const)(
    "directory %s protects descendants and does not block an unrelated directory",
    async (toolName) => {
      const { scheduler, facts } = fixture();
      await fs.mkdir(path.join(root, "tree"));
      await fs.mkdir(path.join(root, "other"));
      await fs.writeFile(path.join(root, "tree", "child.txt"), "needle\n");
      await fs.writeFile(path.join(root, "other", "other.txt"), "needle\n");
      const holder = await acquireResources([
        {
          kind: "file",
          path: path.join(root, "tree", "child.txt"),
          scope: "file",
          mode: "write",
        },
      ]);
      const params =
        toolName === "list"
          ? {}
          : { pattern: toolName === "glob" ? "*.txt" : "needle" };
      const blocked = scheduler.execute(
        request("blocked", toolName, { ...params, path: "tree" }),
      );
      try {
        await expect
          .poll(() =>
            facts.some(
              (f) => f.owner.callId === "blocked" && f.reason === "resource",
            ),
          )
          .toBe(true);
        const independent = await scheduler.execute(
          request("independent", toolName, { ...params, path: "other" }),
        );
        expect(independent.status).toBe("success");
        expect(
          facts.some(
            (f) => f.owner.callId === "blocked" && f.phase === "started",
          ),
        ).toBe(false);
        holder.release();
        const result = await blocked;
        expect(result.status).toBe("success");
        expect(result.output).toContain("child.txt");
      } finally {
        holder.release();
        await blocked;
      }
    },
  );

  it("todo writes preserve one scope's order while a different scope remains independent", async () => {
    const backing = new InMemoryTodoStore();
    const gate = deferred();
    let firstEntered = false;
    const store: TodoStore = {
      read: (...args) => backing.read(...args),
      async write(...args) {
        if (args[1][0]?.content === "first") {
          firstEntered = true;
          await gate.promise;
        }
        return backing.write(...args);
      },
    };
    const { scheduler, facts } = fixture(store);
    const todos = (content: string): Record<string, unknown> => ({
      todos: [{ content, status: "pending" }],
    });
    const first = scheduler.execute({
      ...request("first-todo", "todo_write", todos("first")),
      contextScopeId: "scope-a",
    });
    let second: ReturnType<typeof scheduler.execute> | undefined;
    try {
      await expect.poll(() => firstEntered).toBe(true);
      second = scheduler.execute({
        ...request("second-todo", "todo_write", todos("second")),
        contextScopeId: "scope-a",
      });
      await expect
        .poll(() =>
          facts.some(
            (f) => f.owner.callId === "second-todo" && f.reason === "resource",
          ),
        )
        .toBe(true);
      const other = await scheduler.execute({
        ...request("other-todo", "todo_write", todos("other")),
        contextScopeId: "scope-b",
      });
      expect(other.status).toBe("success");
      expect(await backing.read("session", "scope-b")).toEqual([
        { content: "other", status: "pending" },
      ]);
      expect(await backing.read("session", "scope-a")).toEqual([]);
      gate.resolve();
      expect((await first).status).toBe("success");
      expect((await second).status).toBe("success");
      expect(await backing.read("session", "scope-a")).toEqual([
        { content: "second", status: "pending" },
      ]);
    } finally {
      gate.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it("unknown extension calls retain batch order without locking other sessions globally", async () => {
    const { scheduler } = fixture();
    const gate = deferred();
    const order: string[] = [];
    const extension: Tool = {
      name: "unknown-extension",
      description: "test extension",
      source: "builtin",
      category: "readonly",
      parametersJsonSchema: { type: "object" },
      async execute(params) {
        const id = String(params.id);
        order.push(id);
        if (id === "first") await gate.promise;
        return { output: id };
      },
    };
    scheduler.register(extension);
    const batch = scheduler.executeBatch({
      calls: [
        request("first", extension.name, { id: "first" }),
        request("second", extension.name, { id: "second" }),
      ],
    });
    try {
      await expect.poll(() => order.includes("first")).toBe(true);
      const other = await scheduler.execute(
        request("other", extension.name, { id: "other" }, "other-session"),
      );
      expect(other.status).toBe("success");
      expect(order).toEqual(["first", "other"]);
      gate.resolve();
      expect((await batch).map((result) => result.status)).toEqual([
        "success",
        "success",
      ]);
      expect(order).toEqual(["first", "other", "second"]);
    } finally {
      gate.resolve();
      await batch;
    }
  });
});
