import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../database/index.js";
import {
  buildSearchSnippet,
  InvalidGlobalSessionCursorError,
  listGlobalSessions,
  searchGlobalSessions,
  splitSearchKeywords,
} from "./global-query.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ohbaby-global-sessions-"));
  initDatabase({ dbPath: join(root, "agent.db") });
});

afterEach(async () => {
  closeDatabase();
  await rm(root, { recursive: true, force: true });
});

function addSession(input: {
  readonly id: string;
  readonly updatedAt: number;
  readonly title?: string;
  readonly projectRoot?: string;
  readonly projectDirectory?: string | null;
  readonly status?: "active" | "archived";
  readonly parentId?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO session
        (id, project_id, project_root, project_directory, parent_id, title,
         status, created_at, updated_at, data)
       VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectRoot ?? "/repo/a",
      input.projectDirectory === undefined
        ? (input.projectRoot ?? "/repo/a")
        : input.projectDirectory,
      input.parentId ?? null,
      input.title ?? input.id,
      input.status ?? "active",
      input.updatedAt,
      input.updatedAt,
      JSON.stringify({ isSubagent: input.parentId !== undefined }),
    );
}

let order = 0;

function addMessage(input: {
  readonly sessionId: string;
  readonly id: string;
  readonly role?: "user" | "assistant" | "system";
  readonly parts: readonly (
    | string
    | {
        readonly type: string;
        readonly text: string;
        readonly synthetic?: boolean;
      }
  )[];
  readonly contextScopeId?: string;
  readonly runtimeInputKind?: string;
}): void {
  const db = getDatabase();
  order += 1;
  db.prepare(
    `INSERT INTO message (id, session_id, context_scope_id, role, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.contextScopeId ?? null,
    input.role ?? "user",
    order,
    order,
    JSON.stringify(
      input.runtimeInputKind === undefined
        ? {}
        : { runtimeInput: { kind: input.runtimeInputKind } },
    ),
  );
  input.parts.forEach((part, index) => {
    const value =
      typeof part === "string" ? { type: "text", text: part } : part;
    db.prepare(
      `INSERT INTO part (id, message_id, session_id, type, order_index, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${input.id}_part_${String(index)}`,
      input.id,
      input.sessionId,
      value.type,
      index,
      order,
      order,
      JSON.stringify(value),
    );
  });
}

function searchIds(query: string): readonly string[] {
  return searchGlobalSessions({ query }).hits.map((hit) => hit.session.id);
}

describe("listGlobalSessions", () => {
  it("lists active root sessions of every project, newest first, page by page", () => {
    addSession({ id: "a1", updatedAt: 10, projectRoot: "/repo/a" });
    addSession({ id: "b1", updatedAt: 30, projectRoot: "/repo/b" });
    addSession({
      id: "chat",
      updatedAt: 20,
      projectRoot: "/home/.ohbaby/workspace/default",
      projectDirectory: null,
    });
    addSession({ id: "archived", updatedAt: 40, status: "archived" });
    addSession({ id: "child", updatedAt: 50, parentId: "a1" });

    const first = listGlobalSessions({ limit: 2 });
    expect(first.sessions.map((session) => session.id)).toEqual(["b1", "chat"]);
    expect(first.sessions[1]?.projectDirectory).toBeUndefined();
    const second = listGlobalSessions({ limit: 2, cursor: first.nextCursor });
    expect(second.sessions.map((session) => session.id)).toEqual(["a1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("pages past the maximum page size to the oldest session", () => {
    for (let index = 0; index < 520; index += 1) {
      addSession({
        id: `s${String(index).padStart(3, "0")}`,
        updatedAt: index,
      });
    }
    const first = listGlobalSessions({ limit: 10_000 });
    expect(first.sessions).toHaveLength(500);
    const rest = listGlobalSessions({ limit: 500, cursor: first.nextCursor });
    expect(rest.sessions.map((session) => session.id).at(-1)).toBe("s000");
  });

  it("leaves hidden projects out of the list but keeps sessions moved out of them", () => {
    getDatabase()
      .prepare(
        `INSERT INTO workspace_registry (scope_key, visibility, position, created_at, updated_at, last_opened_at)
         VALUES ('/repo/hidden', 'hidden', 0, 1, 1, 1)`,
      )
      .run();
    addSession({
      id: "hidden-session",
      updatedAt: 3,
      projectRoot: "/repo/hidden",
      title: "needle",
    });
    addSession({
      id: "moved-out",
      updatedAt: 2,
      projectRoot: "/repo/hidden",
      projectDirectory: null,
    });
    addSession({ id: "visible", updatedAt: 1 });

    expect(listGlobalSessions().sessions.map((session) => session.id)).toEqual([
      "moved-out",
      "visible",
    ]);
    expect(searchIds("needle")).toEqual(["hidden-session"]);
  });

  it("rejects malformed cursors", () => {
    expect(() => listGlobalSessions({ cursor: "not-a-cursor" })).toThrow(
      InvalidGlobalSessionCursorError,
    );
  });
});

describe("searchGlobalSessions", () => {
  it("requires every keyword in one title or one message, in any order", () => {
    addSession({ id: "same", updatedAt: 1 });
    addMessage({ sessionId: "same", id: "m1", parts: ["报错发生在登录时"] });
    addSession({ id: "split", updatedAt: 2 });
    addMessage({ sessionId: "split", id: "m2", parts: ["登录"] });
    addMessage({ sessionId: "split", id: "m3", parts: ["报错"] });
    addSession({ id: "title-and-body", updatedAt: 3, title: "登录" });
    addMessage({ sessionId: "title-and-body", id: "m4", parts: ["报错"] });
    addSession({ id: "title", updatedAt: 4, title: "报错 与 登录" });

    expect(searchIds("  登录   报错 ")).toEqual(["title", "same"]);
  });

  it("matches keywords across text blocks of one assistant message", () => {
    addSession({ id: "blocks", updatedAt: 1 });
    addMessage({
      sessionId: "blocks",
      id: "m1",
      role: "assistant",
      parts: ["先检查登录", { type: "tool", text: "ignored" }, "再看报错"],
    });
    expect(searchIds("登录 报错")).toEqual(["blocks"]);
  });

  it("matches literal substrings and folds only English case", () => {
    addSession({ id: "timeout", updatedAt: 1 });
    addMessage({
      sessionId: "timeout",
      id: "m1",
      parts: ["api request TIMEOUT"],
    });
    addSession({ id: "gap", updatedAt: 2 });
    addMessage({ sessionId: "gap", id: "m2", parts: ["登录后出现报错"] });
    addSession({ id: "literal", updatedAt: 3 });
    addMessage({
      sessionId: "literal",
      id: "m3",
      parts: ["path a.b uses 100% of _x"],
    });
    addSession({ id: "wildcard", updatedAt: 4 });
    addMessage({
      sessionId: "wildcard",
      id: "m4",
      parts: ["axb 100 percent yx"],
    });

    expect(searchIds("API timeout")).toEqual(["timeout"]);
    expect(searchIds("登录报错")).toEqual([]);
    expect(searchIds("a.b")).toEqual(["literal"]);
    expect(searchIds("%")).toEqual(["literal"]);
    expect(searchIds("_x")).toEqual(["literal"]);
  });

  it("ignores tool output, reasoning, synthetic text, system and subagent scopes", () => {
    addSession({ id: "hidden", updatedAt: 1 });
    addMessage({
      sessionId: "hidden",
      id: "m1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "secret" },
        { type: "tool", text: "secret" },
        { type: "text", text: "secret", synthetic: true },
      ],
    });
    addMessage({
      sessionId: "hidden",
      id: "m2",
      role: "system",
      parts: ["secret"],
    });
    addMessage({
      sessionId: "hidden",
      id: "m3",
      parts: ["secret"],
      contextScopeId: "subagent_scope",
    });
    expect(searchIds("secret")).toEqual([]);
  });

  it("searches user steering but not internal runtime inputs", () => {
    addSession({ id: "notices", updatedAt: 1 });
    addMessage({
      sessionId: "notices",
      id: "m1",
      parts: ["internal-only-marker"],
      runtimeInputKind: "subagent-status",
    });
    addSession({ id: "steer", updatedAt: 2 });
    addMessage({
      sessionId: "steer",
      id: "m2",
      parts: ["steer-marker"],
      runtimeInputKind: "user-steer",
    });

    expect(searchIds("internal-only-marker")).toEqual([]);
    expect(searchIds("steer-marker")).toEqual(["steer"]);
  });

  it("sorts title hits first, returns each session once with a snippet", () => {
    addSession({ id: "body-new", updatedAt: 100 });
    addMessage({ sessionId: "body-new", id: "m1", parts: ["deploy failed"] });
    addMessage({ sessionId: "body-new", id: "m2", parts: ["deploy again"] });
    addSession({ id: "title-old", updatedAt: 1, title: "Deploy notes" });

    const page = searchGlobalSessions({ query: "deploy" });
    expect(page.hits.map((hit) => [hit.session.id, hit.matchType])).toEqual([
      ["title-old", "title"],
      ["body-new", "message"],
    ]);
    expect(page.hits[1]).toMatchObject({
      messageId: "m2",
      snippet: "deploy again",
    });
  });

  it("searches the whole history beyond the list page size", () => {
    addSession({ id: "oldest", updatedAt: 0, title: "needle" });
    addMessage({
      sessionId: "oldest",
      id: "m0",
      parts: ["x".repeat(20_000) + " haystack-end"],
    });
    for (let index = 1; index <= 520; index += 1) {
      addSession({ id: `s${String(index)}`, updatedAt: index });
    }
    expect(searchIds("needle")).toEqual(["oldest"]);
    expect(searchIds("haystack-end")).toEqual(["oldest"]);
  });

  it("pages search results without repeating sessions", () => {
    for (let index = 0; index < 5; index += 1) {
      addSession({ id: `t${String(index)}`, updatedAt: index, title: "match" });
      addSession({ id: `b${String(index)}`, updatedAt: index + 10 });
      addMessage({
        sessionId: `b${String(index)}`,
        id: `mb${String(index)}`,
        parts: ["match"],
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = searchGlobalSessions({ query: "match", limit: 3, cursor });
      seen.push(...page.hits.map((hit) => hit.session.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      "t4",
      "t3",
      "t2",
      "t1",
      "t0",
      "b4",
      "b3",
      "b2",
      "b1",
      "b0",
    ]);
  });

  it("treats blank queries as no search", () => {
    expect(splitSearchKeywords("   ")).toEqual([]);
    expect(searchGlobalSessions({ query: " " }).hits).toEqual([]);
  });

  it("centers the snippet on the first keyword", () => {
    const text = `${"a".repeat(200)} Needle ${"b".repeat(200)}`;
    const snippet = buildSearchSnippet(text, ["needle"]);
    expect(snippet).toContain("Needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
