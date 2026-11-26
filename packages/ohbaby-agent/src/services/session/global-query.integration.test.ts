import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRetriedAttemptIds } from "ohbaby-sdk";
import { isSearchableMessage } from "./search-visibility.js";
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
  readonly workingDirectory?: string;
  readonly workspaceDirectory?: string | null;
  readonly status?: "active" | "archived";
  readonly parentId?: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO session
        (id, project_id, working_directory, workspace_directory, parent_id, title,
         status, created_at, updated_at, data)
       VALUES (?, 'global', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.workingDirectory ?? "/repo/a",
      input.workspaceDirectory === undefined
        ? (input.workingDirectory ?? "/repo/a")
        : input.workspaceDirectory,
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
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
  )[];
  readonly contextScopeId?: string;
  readonly runtimeInputKind?: string;
  readonly data?: Readonly<Record<string, unknown>>;
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
      input.data ??
        (input.runtimeInputKind === undefined
          ? {}
          : { runtimeInput: { kind: input.runtimeInputKind } }),
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
    addSession({ id: "a1", updatedAt: 10, workingDirectory: "/repo/a" });
    addSession({ id: "b1", updatedAt: 30, workingDirectory: "/repo/b" });
    addSession({
      id: "chat",
      updatedAt: 20,
      workingDirectory: "/home/.ohbaby/workspace/default",
      workspaceDirectory: null,
    });
    addSession({ id: "archived", updatedAt: 40, status: "archived" });
    addSession({ id: "child", updatedAt: 50, parentId: "a1" });

    const first = listGlobalSessions({ limit: 2 });
    expect(first.sessions.map((session) => session.id)).toEqual(["b1", "chat"]);
    expect(first.sessions[1]?.workspaceDirectory).toBeUndefined();
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
      workingDirectory: "/repo/hidden",
      title: "needle",
    });
    addSession({
      id: "moved-out",
      updatedAt: 2,
      workingDirectory: "/repo/hidden",
      workspaceDirectory: null,
    });
    addSession({ id: "visible", updatedAt: 1 });

    expect(listGlobalSessions().sessions.map((session) => session.id)).toEqual([
      "moved-out",
      "visible",
    ]);
    expect(searchIds("needle")).toEqual(["hidden-session"]);
  });

  it("carries when the latest main turn with a result ended", () => {
    const run = (
      sessionId: string,
      runId: string,
      status: string,
      endedAt: number | null,
      contextScopeId: string | null = null,
    ): void => {
      getDatabase()
        .prepare(
          `INSERT INTO run_ledger
            (run_id, session_id, trigger, status, created_at, ended_at, context_scope_id)
           VALUES (?, ?, 'user', ?, ?, ?, ?)`,
        )
        .run(runId, sessionId, status, endedAt ?? 1, endedAt, contextScopeId);
    };
    for (const [id, updatedAt] of [
      ["succeeded", 60],
      ["failed-last", 50],
      ["stopped-last", 40],
      ["subagent-only", 30],
      ["running", 20],
      ["none", 10],
    ] as const)
      addSession({ id, updatedAt });
    run("succeeded", "r1", "succeeded", 1_000);
    run("failed-last", "r2", "succeeded", 1_000);
    run("failed-last", "r3", "failed", 2_000);
    run("stopped-last", "r4", "succeeded", 1_000);
    run("stopped-last", "r5", "interrupted", 3_000);
    run("stopped-last", "r5b", "cancelled", 4_000);
    run("subagent-only", "r6", "succeeded", 1_000, "scope-1");
    run("running", "r7", "running", null);

    const page = listGlobalSessions({ limit: 10 });

    expect(page.sessions.map((session) => session.id)).toEqual([
      "succeeded",
      "failed-last",
      "stopped-last",
      "subagent-only",
      "running",
      "none",
    ]);
    expect(
      page.sessions.map((session) => session.lastTurnEndedAt ?? null),
    ).toEqual([1_000, 2_000, 1_000, null, null, null]);
    expect(
      page.sessions.filter((session) => "lastTurnEndedAt" in session),
    ).toHaveLength(3);
    // Later pages carry it too: the time is read for each page's rows.
    const first = listGlobalSessions({ limit: 2 });
    const second = listGlobalSessions({ limit: 2, cursor: first.nextCursor });
    expect(
      [...first.sessions, ...second.sessions].map((session) => [
        session.id,
        session.lastTurnEndedAt ?? null,
      ]),
    ).toEqual([
      ["succeeded", 1_000],
      ["failed-last", 2_000],
      ["stopped-last", 1_000],
      ["subagent-only", null],
    ]);
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

  it("sorts by session age and includes the latest body hit even when the title matches", () => {
    addSession({ id: "body-new", updatedAt: 100, title: "Deploy failed" });
    addMessage({ sessionId: "body-new", id: "m1", parts: ["deploy failed"] });
    addMessage({ sessionId: "body-new", id: "m2", parts: ["deploy again"] });
    addSession({ id: "title-old", updatedAt: 1, title: "Deploy notes" });

    const page = searchGlobalSessions({ query: "deploy" });
    expect(
      page.hits.map(({ session, ...hit }) => ({ ...hit, id: session.id })),
    ).toEqual([
      {
        id: "body-new",
        messageId: "m2",
        snippet: "deploy again",
      },
      { id: "title-old" },
    ]);
  });

  it("searches and quotes only display text, including legacy and empty display values", () => {
    addSession({ id: "display", updatedAt: 1 });
    addMessage({
      sessionId: "display",
      id: "m",
      parts: [
        {
          type: "text",
          text: "private goal",
          metadata: { displayText: "超时" },
        },
        { type: "text", text: "private empty", metadata: { displayText: "" } },
        {
          type: "text",
          text: "private summary",
          metadata: { kind: "context-summary" },
        },
        {
          type: "text",
          text: "private summary",
          metadata: { kind: "context-compaction" },
        },
        {
          type: "text",
          text: "private terminal",
          metadata: { kind: "lifecycle-interruption" },
        },
        { type: "text", text: "path C:\\repo", metadata: { displayText: 42 } },
        { type: "tool", text: "private error" },
        { type: "reasoning", text: "private thought" },
      ],
    });
    expect(searchIds("private")).toEqual([]);
    expect(
      searchGlobalSessions({ query: "repo 超时 \\" }).hits[0],
    ).toMatchObject({
      messageId: "m",
      snippet: "超时 path C:\\repo",
    });
    getDatabase()
      .prepare("UPDATE message SET rewound_at='now' WHERE id='m'")
      .run();
    expect(searchIds("repo")).toEqual([]);
    expect(isSearchableMessage("display", "m")).toBe(false);
  });

  it("excludes replaced attempts before ranking, in agreement with the SDK", () => {
    addSession({ id: "s", updatedAt: 1 });
    const request = {
      purpose: "agent-step",
      requestId: "req",
      runId: "r",
      messageId: "old",
      step: 2,
      attempt: 1,
      outcome: "error",
      retryScheduled: true,
      startedAt: 1,
    } as const;
    const failed = {
      id: "old",
      runId: "r",
      role: "assistant",
      status: "error",
      parts: [],
      createdAt: "now",
      modelRequests: [request],
    } as const;
    addMessage({ sessionId: "s", id: "visible", parts: ["needle first"] });
    addMessage({
      sessionId: "s",
      id: "old",
      role: "assistant",
      parts: ["needle obsolete"],
      data: {
        modelRequests: failed.modelRequests,
        runId: "r",
        error: { name: "error" },
        time: { completed: 2 },
      },
    });
    function check(replaced: boolean): void {
      expect(isSearchableMessage("s", "old")).toBe(!replaced);
      expect(searchGlobalSessions({ query: "needle" }).hits[0]?.messageId).toBe(
        replaced ? "visible" : "old",
      );
    }
    check(listRetriedAttemptIds([failed]).has("old"));
    const next = {
      ...failed,
      id: "new",
      modelRequests: [
        { ...request, messageId: "new", attempt: 2, startedAt: 3 },
      ],
    };
    addMessage({
      sessionId: "s",
      id: "new",
      role: "assistant",
      parts: ["different"],
      data: {
        runId: "r",
        modelRequests: next.modelRequests,
      },
    });
    check(listRetriedAttemptIds([failed, next]).has("old"));
    expect(searchIds("obsolete")).toEqual([]);
    // The last owned request wins, even if the earlier failure scheduled a retry.
    getDatabase()
      .prepare(
        `UPDATE message SET data=json_set(data,'$.modelRequests',json(?)) WHERE id='old'`,
      )
      .run(JSON.stringify([request, { ...request, outcome: "success" }]));
    check(false);
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
    addSession({ id: "b4-tie", updatedAt: 14, title: "match" });
    const expected = [
      "b4-tie",
      "b4",
      "b3",
      "b2",
      "b1",
      "b0",
      "t4",
      "t3",
      "t2",
      "t1",
      "t0",
    ];
    for (const order of ["asc", "desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = searchGlobalSessions({
          query: "match",
          limit: 3,
          cursor,
          order,
        });
        seen.push(...page.hits.map((hit) => hit.session.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(order === "desc" ? expected : expected.toReversed());
    }
    const { nextCursor } = searchGlobalSessions({ query: "match", limit: 1 });
    expect(() =>
      searchGlobalSessions({
        query: "match",
        order: "asc",
        cursor: nextCursor,
      }),
    ).toThrow(InvalidGlobalSessionCursorError);
    expect(() => listGlobalSessions({ cursor: nextCursor })).toThrow(
      InvalidGlobalSessionCursorError,
    );
  });

  it("treats blank queries as no search", () => {
    expect(splitSearchKeywords("   ")).toEqual([]);
    expect(searchGlobalSessions({ query: " " }).hits).toEqual([]);
  });

  it("keeps about 15 Unicode characters before a match and includes distant hits", () => {
    const text =
      "🐈".repeat(200) +
      "FIRST" +
      "中".repeat(500) +
      "SECOND" +
      "🐕".repeat(300) +
      "THIRD" +
      "末".repeat(100);
    const snippet = buildSearchSnippet(text, ["third", "second", "first"]);
    expect(snippet.startsWith("…" + "🐈".repeat(15) + "FIRST")).toBe(true);
    expect(snippet).toMatch(/FIRST.*….*SECOND.*….*THIRD/u);
    expect(Array.from(snippet)).toHaveLength(120);
  });

  it("preserves a long keyword in full whenever it fits, before adding context", () => {
    for (const size of [105, 115, 119, 120]) {
      const keyword = "🐈".repeat(size);
      const snippet = buildSearchSnippet(
        "头".repeat(500) + keyword + "尾".repeat(500),
        [keyword],
      );
      expect(snippet).toContain(keyword);
      expect(Array.from(snippet).length).toBeLessThanOrEqual(120);
    }
  });

  it("merges overlapping keyword excerpts and keeps their source spelling", () => {
    const text = "头".repeat(100) + "TimeoutError" + "尾".repeat(300);
    const snippet = buildSearchSnippet(text, ["error", "TIMEOUT", "outerror"]);
    expect(snippet.startsWith("…" + "头".repeat(15) + "TimeoutError")).toBe(
      true,
    );
    expect(Array.from(snippet)).toHaveLength(120);
  });

  it("limits excerpts to complete hits in document order when space runs out", () => {
    const words = Array.from({ length: 16 }, (_, i) => `[kw${String(i)}]`);
    const text = words.join("哦".repeat(200));
    const snippet = buildSearchSnippet(text, words.toReversed());
    const found = words.filter((word) => snippet.includes(word));
    expect(found.length).toBeGreaterThan(1);
    expect(found.length).toBeLessThan(words.length);
    expect(found).toEqual(words.slice(0, found.length));
    expect(Array.from(snippet).length).toBeLessThanOrEqual(120);
  });

  it("centers the snippet on the first keyword", () => {
    const text = `${"a".repeat(200)} Needle ${"b".repeat(200)}`;
    const snippet = buildSearchSnippet(text, ["needle"]);
    expect(snippet).toContain("Needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
