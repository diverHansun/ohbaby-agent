import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRPC, type UiBackendClient } from "ohbaby-sdk";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createDatabaseMessageStore,
} from "../../core/message/index.js";
import {
  createPersistentUiBackendClient,
  type PersistentUiBackendClient,
} from "../../adapters/ui-persistent.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../database/index.js";
import { createDatabaseSessionStore } from "../session/database-store.js";
import { getAgentPackageVersion } from "../../package-version.js";
import type { Session } from "../session/types.js";
import type { ExportHeader, ExportMessage } from "./types.js";

let directory: string;
let dbPath: string;
let backend: PersistentUiBackendClient | undefined;
const now = new Date("2026-10-17T07:30:12Z");
const session: Session = {
  id: "session_archived",
  projectId: "p",
  workingDirectory: "/archived-project",
  title: "中文历史",
  agentName: "build",
  status: "archived",
  createdAt: 1000,
  updatedAt: 2000,
  stats: { messageCount: 5 },
  childrenIds: [],
  isSubagent: false,
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ohbaby-export-"));
  dbPath = join(directory, "agent.db");
  initDatabase({ dbPath });
  await createDatabaseSessionStore().insert(session);
});
afterEach(async () => {
  await backend?.dispose();
  backend = undefined;
  closeDatabase();
  await rm(directory, { recursive: true, force: true });
});
function databaseSnapshot(): unknown {
  const db = getDatabase();
  return [
    schema.session.tableName,
    schema.message.tableName,
    schema.part.tableName,
  ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
async function client(): Promise<{
  direct: PersistentUiBackendClient;
  proxy: UiBackendClient;
}> {
  backend = createPersistentUiBackendClient({
    dbPath,
    workdir: directory,
    now: () => now,
    startupSessionMode: { type: "fresh" },
  });
  await backend.getSessionIndex();
  const rpc = createRPC<UiBackendClient>();
  rpc.connectImpl(backend);
  return { direct: backend, proxy: rpc.createProxy({}) };
}
describe("persistent session export", () => {
  it("exports compacted primary history from an unselected archived session without writes or events", async () => {
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      now: () => 3000,
    });
    const user = await manager.createMessage({
      sessionId: session.id,
      role: "user",
      agent: "build",
    });
    const old = await manager.appendPart(user.id, {
      type: "text",
      text: "压缩前正文 👋 $&",
    });
    const compacted = await manager.commitCompaction({
      sessionId: session.id,
      compactedAt: 4000,
      expectedParts: [old],
      summary: { agent: "context", text: "压缩摘要" },
    });
    expect(compacted).toBeDefined();
    const scoped = await manager.createMessage({
      sessionId: session.id,
      role: "assistant",
      agent: "child",
      contextScopeId: "child_scope",
    });
    await manager.appendPart(scoped.id, {
      type: "text",
      text: "__CHILD_CONTEXT_SECRET__",
    });
    const latest = await manager.createMessage({
      sessionId: session.id,
      role: "assistant",
      agent: "build",
      providerId: "test",
      modelId: "model",
    });
    await manager.appendPart(latest.id, {
      type: "tool",
      tool: "bash",
      callId: "call",
      state: {
        status: "aborted",
        input: { command: "demo" },
        output: "partial output",
        error: "Tool execution aborted by user",
      },
    });
    await manager.updateMessage(latest.id, {
      error: { name: "MessageAbortedError", message: "stopped" },
      time: { created: latest.time.created, completed: 5000 },
    });
    const { direct, proxy } = await client();
    const event = vi.fn();
    const unsubscribe = direct.subscribeEvents(event);
    const snapshot = databaseSnapshot();
    const selected = await direct.getSelectedSessionId();
    const input = { sessionId: session.id, format: "jsonl" as const };
    const output = await direct.exportSession(input);
    expect(await proxy.exportSession(input)).toEqual(output);
    const [header, ...messages] = output.content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ExportHeader | ExportMessage) as [
      ExportHeader,
      ...ExportMessage[],
    ];
    expect(header.session.status).toBe("archived");
    expect(header.app.version).toBe(getAgentPackageVersion());
    expect(messages.flatMap((message) => message.parts)).toContainEqual({
      type: "text",
      text: "压缩前正文 👋 $&",
      compacted: true,
    });
    const summary = messages.find(
      (message) => message.kind === "compaction-summary",
    );
    expect(summary).toMatchObject({
      status: "completed",
      parts: [{ text: "压缩摘要" }],
    });
    expect(summary?.time).not.toHaveProperty("completed");
    expect(messages.find((message) => message.id === latest.id)).toMatchObject({
      status: "aborted",
      parts: [
        {
          type: "tool",
          status: "aborted",
          output: "partial output",
          error: "Tool execution aborted by user",
        },
      ],
    });
    expect(output.content).not.toContain("__CHILD_CONTEXT_SECRET__");
    expect(output.messageCount).toBe(3);
    expect(databaseSnapshot()).toEqual(snapshot);
    expect(await direct.getSelectedSessionId()).toBe(selected);
    expect(event).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("keeps stable failures across the in-process RPC boundary", async () => {
    await createDatabaseSessionStore().insert({
      ...session,
      id: "child",
      isSubagent: true,
      parentId: session.id,
    });
    const { direct, proxy } = await client();
    for (const target of [direct, proxy]) {
      await expect(
        target.exportSession({ sessionId: "absent", format: "html" }),
      ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expect(
        target.exportSession({ sessionId: "child", format: "html" }),
      ).rejects.toMatchObject({ code: "SUBAGENT_SESSION" });
      await expect(
        target.exportSession({ sessionId: session.id, format: "html" }),
      ).rejects.toMatchObject({ code: "EMPTY_SESSION" });
    }
  });
});
