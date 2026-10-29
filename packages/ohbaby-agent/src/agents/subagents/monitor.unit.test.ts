import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type CreatePartInput,
  type MessageManager,
  type MessageStore,
} from "../../core/message/index.js";
import {
  InMemorySubagentExecutionStore,
  type SubagentExecutionRecord,
} from "./execution-store.js";
import { InMemorySubagentInstanceStore } from "./in-memory-store.js";
import { createSubagentMonitor } from "./monitor.js";

interface Fixture {
  instances: InMemorySubagentInstanceStore;
  executions: InMemorySubagentExecutionStore;
  store: MessageStore;
  messages: MessageManager;
  monitor: ReturnType<typeof createSubagentMonitor>;
  agent(
    id?: string,
    parentSessionId?: string,
    requesterScopeId?: string,
  ): Promise<SubagentExecutionRecord>;
  message(
    id: string,
    subagentId?: string,
    content?: CreatePartInput[],
    created?: number,
  ): Promise<void>;
}

function fixture(): Fixture {
  const instances = new InMemorySubagentInstanceStore();
  const executions = new InMemorySubagentExecutionStore();
  const store = createInMemoryMessageStore();
  const messages = createMessageManager({ bus: createBus(), store });
  const monitor = createSubagentMonitor({ instances, executions, messages });
  async function agent(
    id = "a",
    parentSessionId = "root",
    requesterScopeId = "primary",
  ): Promise<SubagentExecutionRecord> {
    await instances.create({
      subagentId: id,
      parentSessionId,
      sessionId: "shared",
      contextScopeId: id,
      role: "explore",
      name: `Agent ${id}`,
      initialPrompt: "Investigate",
      status: "running",
      pendingQueue: [],
      createdAt: 1,
      updatedAt: 2,
    });
    const { record } = await executions.accept({
      executionId: `${id}-execution`,
      requestId: `${id}-request`,
      parentSessionId,
      rootSessionId: parentSessionId,
      requesterScopeId,
      requesterRunId: "root-run",
      rootRunId: "root-run",
      subagentId: id,
      mode: "background",
      prompt: "Investigate",
      createdAt: 1,
    });
    await executions.bindChild(
      record,
      { sessionId: "shared", contextScopeId: id },
      2,
    );
    await executions.start(record, `${id}-run`, 2);
    return record;
  }
  async function message(
    id: string,
    subagentId = "a",
    content: CreatePartInput[] = [{ type: "text", text: id }],
    created = 10,
  ): Promise<void> {
    const info = {
      id,
      sessionId: "shared",
      contextScopeId: subagentId,
      runId: `${subagentId}-run`,
      role: "assistant",
      agent: "explore",
      time: { created },
    } as const;
    await store.insertMessage(info);
    for (const [index, data] of content.entries())
      await store.appendPart({
        message: info,
        partId: `${id}-${String(index)}`,
        data,
        updatedAt: created,
      });
  }
  return { instances, executions, store, messages, monitor, agent, message };
}

describe("subagent monitor", () => {
  it("reads closed saved history without mutating execution or instance facts", async () => {
    const f = fixture();
    const execution = await f.agent();
    await f.executions.finish(execution, {
      status: "interrupted",
      completedAt: 3,
      error: "stopped",
    });
    await f.instances.update("a", {
      status: "interrupted",
      closedAt: 4,
      updatedAt: 4,
    });
    await f.message("saved", "a", [
      { type: "text", text: "Saved answer" },
      { type: "reasoning", text: "Saved reasoning" },
      {
        type: "tool",
        callId: "tool-call",
        tool: "shell",
        state: {
          status: "error",
          input: { command: "pwd" },
          output: "partial stdout",
          error: "exit 1",
        },
      },
    ]);
    const before = {
      instance: await f.instances.get({
        parentSessionId: "root",
        subagentId: "a",
      }),
      execution: await f.executions.get(execution),
      messages: await f.messages.listBySession("shared"),
    };
    const writes = [
      vi.spyOn(f.instances, "update"),
      vi.spyOn(f.executions, "updateArtifact"),
      vi.spyOn(f.executions, "markDelivered"),
      vi.spyOn(f.executions, "subscribe"),
      vi.spyOn(f.messages, "createMessage"),
    ];
    const result = await f.monitor({
      parentSessionId: "root",
      subagentIds: ["a"],
    });
    expect(result.targets[0]).toMatchObject({
      subagentId: "a",
      item: { status: "interrupted", closedAt: 4 },
      executions: [
        { executionId: "a-execution", status: "interrupted", error: "stopped" },
      ],
    });
    const content = result.targets[0].records[0].content;
    for (const text of [
      "Saved answer",
      "Saved reasoning",
      "shell",
      "pwd",
      "partial stdout",
      "exit 1",
    ])
      expect(content).toContain(text);
    expect({
      instance: await f.instances.get({
        parentSessionId: "root",
        subagentId: "a",
      }),
      execution: await f.executions.get(execution),
      messages: await f.messages.listBySession("shared"),
    }).toEqual(before);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("isolates missing and foreign targets without revealing their saved messages", async () => {
    const f = fixture();
    await f.agent();
    await f.agent("foreign", "other-root");
    await f.agent("nested", "root", "another-scope");
    await f.message("visible");
    await f.message("secret", "foreign");
    await f.message("nested-secret", "nested");
    const result = await f.monitor({
      parentSessionId: "root",
      subagentIds: ["missing", "foreign", "nested", "a"],
    });
    expect(
      result.targets.slice(0, 3).map((target) => target.error?.code),
    ).toEqual([
      "SUBAGENT_NOT_FOUND",
      "SUBAGENT_NOT_FOUND",
      "SUBAGENT_NOT_FOUND",
    ]);
    expect(result.targets[3].records.map((record) => record.messageId)).toEqual(
      ["visible"],
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("pages twenty latest records backwards with stable equal-time ordering", async () => {
    const f = fixture();
    await f.agent();
    for (let index = 0; index < 25; index++)
      await f.message(`message-${String(index).padStart(2, "0")}`);
    const first = (
      await f.monitor({ parentSessionId: "root", subagentIds: ["a"] })
    ).targets[0];
    expect(first.records).toHaveLength(20);
    expect(first.records[0].messageId).toBe("message-05");
    expect(first.records.at(-1)?.messageId).toBe("message-24");
    expect(first.cursor).toEqual(expect.any(String));
    if (!first.cursor) throw new Error("Expected an earlier-page cursor");
    await f.message("new-message", "a", undefined, 11);
    const second = (
      await f.monitor({
        parentSessionId: "root",
        subagentIds: ["a"],
        cursors: { a: first.cursor },
      })
    ).targets[0];
    expect(second.records.map((record) => record.messageId)).toEqual([
      "message-00",
      "message-01",
      "message-02",
      "message-03",
      "message-04",
    ]);
    expect(second.cursor).toBeUndefined();
    expect(second.truncated).toBe(false);
  });

  it("selects the newest acceptance when execution timestamps collide", async () => {
    const f = fixture();
    const previous = await f.agent();
    await f.executions.finish(previous, {
      status: "completed",
      completedAt: 3,
    });
    await f.executions.accept({
      ...previous,
      executionId: "000-new",
      requestId: "new-request",
      createdAt: 1,
    });
    const target = (
      await f.monitor({ parentSessionId: "root", subagentIds: ["a"] })
    ).targets[0];
    expect(target.executions.map((execution) => execution.executionId)).toEqual(
      ["000-new"],
    );
  });

  it("uses saved display text and excludes hidden model context", async () => {
    const f = fixture();
    await f.agent();
    await f.message("visible", "a", [
      {
        type: "text",
        text: "raw-context",
        metadata: { displayText: "Visible text" },
      },
      {
        type: "text",
        text: "hidden-runtime",
        synthetic: true,
        metadata: { kind: "model-context:runtime:v1" },
      },
    ]);
    const target = (
      await f.monitor({ parentSessionId: "root", subagentIds: ["a"] })
    ).targets[0];
    expect(target.records[0].content).toBe("Visible text");
  });

  it("isolates a failed storage read and does not expose its internal error text", async () => {
    const f = fixture();
    await f.agent();
    await f.agent("b");
    await f.message("b-visible", "b");
    vi.spyOn(f.messages, "listPageBySession").mockRejectedValueOnce(
      new Error("private database content"),
    );
    const result = await f.monitor({
      parentSessionId: "root",
      subagentIds: ["a", "b"],
    });
    expect(result.targets[0].error?.code).toBe("MONITOR_UNAVAILABLE");
    expect(result.targets[1].records[0].messageId).toBe("b-visible");
    expect(JSON.stringify(result)).not.toContain("private database");
  });

  it("rejects malformed and cross-instance cursors while other targets remain readable", async () => {
    const f = fixture();
    await f.agent();
    await f.agent("b");
    for (let index = 0; index < 21; index++)
      await f.message(`message-${String(index)}`);
    await f.message("b-message", "b");
    const cursor = (
      await f.monitor({ parentSessionId: "root", subagentIds: ["a"] })
    ).targets[0].cursor;
    if (!cursor) throw new Error("Expected an earlier-page cursor");
    for (const invalid of [cursor, "not-a-cursor"]) {
      const result = await f.monitor({
        parentSessionId: "root",
        subagentIds: ["b", "a"],
        cursors: { b: invalid },
      });
      expect(result.targets[0]).toMatchObject({
        subagentId: "b",
        error: { code: "INVALID_MONITOR_CURSOR" },
        records: [],
      });
      expect(result.targets[1].records.length).toBeGreaterThan(0);
    }
  });

  it("bounds UTF-8 output across six targets, retains artifact references and does not skip omitted records", async () => {
    const f = fixture();
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (const id of ids) {
      const execution = await f.agent(id);
      await f.executions.finish(execution, {
        status: "completed",
        completedAt: 3,
      });
      await f.executions.updateArtifact(
        execution,
        { state: "ready", path: `/saved/${id}.txt`, sizeBytes: 50000 },
        3,
      );
      await f.message(`${id}-old`, id, [{ type: "text", text: "older" }], 9);
      await f.message(`${id}-long`, id, [
        { type: "text", text: '界🦊"\\'.repeat(10000) },
      ]);
    }
    const result = await f.monitor({
      parentSessionId: "root",
      subagentIds: ids,
    });
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(result.truncated).toBe(true);
    for (const target of result.targets) {
      expect(target.error).toBeUndefined();
      expect(target.records.at(-1)?.messageId).toBe(
        `${target.subagentId}-long`,
      );
      expect(target.records.at(-1)?.truncated).toBe(true);
      expect(target.executions[0].artifactPath).toBe(
        `/saved/${target.subagentId}.txt`,
      );
      expect(JSON.stringify(target)).not.toContain("�");
      if (target.cursor) {
        const earlier = (
          await f.monitor({
            parentSessionId: "root",
            subagentIds: [target.subagentId],
            cursors: { [target.subagentId]: target.cursor },
          })
        ).targets[0];
        expect(earlier.records.map((record) => record.messageId)).toContain(
          `${target.subagentId}-old`,
        );
      } else
        expect(target.records[0].messageId).toBe(`${target.subagentId}-old`);
    }
  });

  it("rejects more than six targets before any reads", async () => {
    const f = fixture();
    const read = vi.spyOn(f.instances, "get");
    await expect(
      f.monitor({
        parentSessionId: "root",
        subagentIds: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_MONITOR_QUERY" });
    expect(read).not.toHaveBeenCalled();
  });
});
