import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  type MessageStore,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";

// Execute complete historical modules, not reimplementations of JSON.parse.
const historicalModules = [
  "core/message/database-store",
  "core/message/pagination",
  "core/message/store",
  "core/message/origin",
  "core/message/token-usage-metadata",
  "core/message/converter",
  "services/database/index",
  "services/database/connection",
  "services/database/errors",
  "services/database/migrations",
  "services/database/path",
  "services/database/busy-retry",
  "services/database/schema",
  "paths/index",
  "paths/ohbaby-home",
  "paths/read-fallback",
  "services/interface-providers/native-state",
];

it("553fc65e real SQLite readers accept current execution/model-request JSON and preserve ordinary edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "rollback-reader-"));
  const dbPath = join(root, "current.db");
  let oldClose: (() => void) | undefined;
  try {
    const revision = execFileSync("git", ["rev-parse", "553fc65e^{commit}"], {
      encoding: "utf8",
    }).trim();
    const manifest: Record<string, string> = {};
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await symlink(
      resolve("packages/ohbaby-agent/node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    for (const path of historicalModules) {
      const sourcePath = `packages/ohbaby-agent/src/${path}.ts`;
      const source = execFileSync(
        "git",
        ["show", `${revision}:${sourcePath}`],
        { encoding: "utf8" },
      );
      manifest[sourcePath] = createHash("sha256").update(source).digest("hex");
      const target = join(root, "old", `${path}.js`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
    }
    initDatabase({ dbPath });
    getDatabase()
      .prepare(
        "INSERT INTO session (id,project_id,project_root,status,created_at,updated_at,data) VALUES ('s','p','/fixture','active',1,1,'{}')",
      )
      .run();
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      now: () => 100,
    });
    const assistant = await manager.createMessage({
      sessionId: "s",
      role: "assistant",
      agent: "default",
      runId: "r",
    });
    await manager.updateMessage(assistant.id, {
      modelRequests: [
        {
          requestId: "new-request",
          runId: "r",
          step: 1,
          attempt: 1,
          messageId: assistant.id,
          purpose: "agent-step",
          startedAt: 10,
          firstTextAt: 20,
          endedAt: 30,
          outcome: "success",
        },
      ],
    });
    await manager.appendPart(assistant.id, {
      type: "text",
      text: "existing answer",
    });
    const tool = await manager.appendPart(assistant.id, {
      type: "tool",
      callId: "call",
      tool: "read",
      state: {
        status: "completed",
        input: { file_path: "owned.txt" },
        output: "old-reader-output",
      },
      metadata: {
        sentinel: "keep",
        execution: {
          phase: "ended",
          outcome: "success",
          executionStartedAt: 11,
          phaseStartedAt: 22,
          createdAt: 10,
          endedAt: 22,
          runId: "r",
          cleanup: "confirmed",
        },
      },
    });
    const second = await manager.createMessage({
      sessionId: "s",
      role: "assistant",
      agent: "default",
      runId: "r",
    });
    await manager.appendPart(second.id, { type: "text", text: "second reply" });
    const expected = await manager.listBySession("s");
    const data = () =>
      getDatabase()
        .prepare(
          "SELECT id,data FROM message UNION ALL SELECT id,data FROM part ORDER BY id",
        )
        .all();
    const before = data();
    const schema = getDatabase()
      .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    closeDatabase();

    const oldDb = await import(
      /* @vite-ignore */ pathToFileURL(
        join(root, "old/services/database/index.js"),
      ).href
    );
    oldClose = oldDb.closeDatabase;
    oldDb.initDatabase({ dbPath });
    const oldModule = await import(
      /* @vite-ignore */ pathToFileURL(
        join(root, "old/core/message/database-store.js"),
      ).href
    );
    const old: MessageStore = oldModule.createDatabaseMessageStore();
    expect(await old.listBySession("s")).toEqual(expected);
    expect(await old.getMessage(assistant.id)).toEqual(expected[0].info);
    expect(await old.getPart(tool.id)).toEqual(tool);
    expect(await old.listByIds("s", [assistant.id])).toEqual([expected[0]]);
    const firstPage = await old.listPageBySession("s", { limit: 1 });
    expect(firstPage.hasMore).toBe(true);
    const next = await old.listPageBySession("s", {
      limit: 1,
      before: firstPage.nextCursor,
    });
    expect(
      [...firstPage.messages, ...next.messages].map((m) => m.info.id).sort(),
    ).toEqual([assistant.id, second.id].sort());
    expect((await old.listPageByRun("s", "r")).messages).toHaveLength(2);
    expect(
      oldDb
        .getDatabase()
        .prepare(
          "SELECT id,data FROM message UNION ALL SELECT id,data FROM part ORDER BY id",
        )
        .all(),
    ).toEqual(before);
    expect(
      oldDb
        .getDatabase()
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
        .all(),
    ).toEqual(schema);
    const converter = await import(
      /* @vite-ignore */ pathToFileURL(
        join(root, "old/core/message/converter.js"),
      ).href
    );
    expect(converter.toModelMessages(await old.listBySession("s"))).toEqual([
      { role: "assistant", content: "existing answerold-reader-output" },
      { role: "assistant", content: "second reply" },
    ]);
    await old.updateMessage(assistant.id, { finish: "stop" });
    await old.updatePart(
      tool.id,
      {
        state: {
          status: "completed",
          input: { file_path: "owned.txt" },
          output: "edited by baseline",
        },
      },
      200,
    );
    oldClose?.();
    oldClose = undefined;
    initDatabase({ dbPath });
    const reopened = createDatabaseMessageStore();
    expect(await reopened.getMessage(assistant.id)).toMatchObject({
      modelRequests:
        expected[0].info.role === "assistant"
          ? expected[0].info.modelRequests
          : undefined,
      finish: "stop",
    });
    expect(await reopened.getPart(tool.id)).toMatchObject({
      metadata: tool.metadata,
      state: { output: "edited by baseline" },
    });
    console.log(
      "ROLLBACK_READER",
      JSON.stringify({
        revision,
        modules: manifest,
        methods: [
          "initDatabase",
          "getMessage",
          "getPart",
          "listBySession",
          "listByIds",
          "listPageBySession",
          "listPageByRun",
          "toModelMessages",
          "updateMessage",
          "updatePart",
        ],
      }),
    );
  } finally {
    oldClose?.();
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});
