import { DatabaseShellJobStore } from "../shell-jobs/store.js";
import { shellJobFixture } from "../shell-jobs/fixtures/shell-job.js";
import { ShellJobRegistry } from "../shell-jobs/registry.js";
import { DatabaseSubagentExecutionStore } from "../agents/subagents/execution-store.js";
import { isOwnerProcessAlive, processOwnerId } from "../utils/process-owner.js";
import { SideChatUnsupportedError } from "../services/session/errors.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { TodoWorkScopeRegistry } from "../tools/todo.js";
import { McpManager, type McpTool } from "../mcp/index.js";
import { resolveSessionStorageDir } from "../paths/session-storage.js";
import { closeDatabase, getDatabase } from "../services/database/index.js";
import {
  commitSessionWorkspaceMove,
  listGlobalSessions,
  searchGlobalSessions,
  planSessionWorkspaceMove,
} from "../services/session/index.js";
import {
  createPersistentUiBackendClient,
  type PersistentUiBackendClient,
} from "./ui-persistent.js";

const lookup = "mcp_s7_example_t6_lookup";
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

describe("conversation copies through the persistent backend", () => {
  let fixtureRoot: string;
  let directory: string;
  let client: PersistentUiBackendClient;
  let peer: PersistentUiBackendClient | undefined;
  let open: () => PersistentUiBackendClient;
  const requests: InterfaceProviderRequest[] = [];
  const calls: ToolCall[] = [];
  const summaries: InterfaceProviderRequest[] = [];
  let overflowNext = false;
  let titleRequests = 0;
  let holdNextAnswer: Promise<void> | undefined;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "session-copy-runtime-"));
    directory = join(fixtureRoot, "work");
    await mkdir(directory);
    vi.stubEnv("OHBABY_HOME", join(fixtureRoot, "home"));
    calls.length = 0;
    summaries.length = 0;
    overflowNext = false;
    titleRequests = 0;
    holdNextAnswer = undefined;
    requests.length = 0;
    vi.spyOn(McpManager.prototype, "getAllTools").mockResolvedValue([
      {
        name: lookup,
        source: "mcp",
        mcpServer: "example",
        mcpToolName: "lookup",
        description: "Look something up",
        isTrusted: true,
        parametersJsonSchema: { type: "object", properties: {} },
        execute: (): Promise<{ output: string }> =>
          Promise.resolve({ output: "ok" }),
      },
    ]);
    const llmClient: LLMClientInstance = {
      config: {
        provider: "openai",
        model: "test-model",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        maxTokens: 256,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "openai",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          const call =
            request.purpose === "agent-step" ? calls.shift() : undefined;
          const hold =
            request.purpose === "agent-step" && !call
              ? holdNextAnswer
              : undefined;
          if (hold) holdNextAnswer = undefined;
          if (request.purpose === "session-title") titleRequests++;
          if (request.purpose === "context-summary") summaries.push(request);
          if (request.purpose === "agent-step") {
            requests.push(request);
            if (overflowNext) {
              overflowNext = false;
              return Promise.reject(
                Object.assign(new Error("context overflow"), {
                  code: "context_length_exceeded",
                }),
              );
            }
          }
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (hold) await hold;
              yield await Promise.resolve(
                call
                  ? {
                      finishReason: "tool_calls" as const,
                      toolCallDeltas: [
                        {
                          id: `${call.name}-${String(requests.length)}`,
                          index: 0,
                          name: call.name,
                          argumentsDelta: JSON.stringify(call.args),
                        },
                      ],
                    }
                  : {
                      textDelta: "Backend fixture reply",
                      finishReason: "stop" as const,
                    },
              );
            })(),
          );
        },
      },
    };
    open = (): PersistentUiBackendClient =>
      createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        workdir: directory,
        llmClient,
        enableSnapshots: false,
      });
    client = open();
  });

  afterEach(async () => {
    await peer?.dispose();
    peer = undefined;
    await client.dispose();
    closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "wakes an idle session once with the persisted background result",
    async () => {
      await client.setPermission({ level: "full-access" });
      calls.push({
        name: "bash",
        args: {
          command: "sleep 0.3; echo task-finished",
          run_in_background: true,
        },
      });
      const { prompt } = await client.submitPromptAndWait(
        "start background task",
      );
      await vi.waitFor(
        () => {
          const rows = getDatabase()
            .prepare<{
              trigger: string;
            }>(
              "SELECT trigger FROM run_ledger WHERE session_id=? ORDER BY created_at",
            )
            .all(prompt.sessionId);
          expect(rows.some((row) => row.trigger === "background-task")).toBe(
            true,
          );
        },
        { timeout: 5000 },
      );
      await vi.waitFor(
        () => {
          expect(
            requests.some((request) =>
              JSON.stringify(request.messages).includes("task-finished"),
            ),
          ).toBe(true);
        },
        { timeout: 5000 },
      );
      const count = getDatabase()
        .prepare<{
          count: number;
        }>(
          "SELECT count(*) AS count FROM run_ledger WHERE session_id=? AND trigger='background-task'",
        )
        .get(prompt.sessionId)?.count;
      expect(count).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "wakes the owning session after another session becomes active",
    async () => {
      await client.setPermission({ level: "full-access" });
      calls.push({
        name: "bash",
        args: {
          command: "sleep 0.5; echo unselected-result",
          run_in_background: true,
        },
      });
      const { prompt } = await client.submitPromptAndWait(
        "start background job",
      );
      const other = await client.createSession();
      await client.submitPromptAndWait("switch session", {
        sessionId: other.id,
      });
      await vi.waitFor(
        () => {
          expect(
            getDatabase()
              .prepare<{
                count: number;
              }>(
                "SELECT count(*) AS count FROM run_ledger WHERE session_id=? AND trigger='background-task'",
              )
              .get(prompt.sessionId)?.count,
          ).toBe(1);
        },
        { timeout: 5000 },
      );
      expect((await client.getSnapshot()).activeSessionId).toBe(other.id);
    },
  );

  it.skipIf(process.platform === "win32")(
    "delivers a result into an already running turn without an extra wake",
    async () => {
      await client.setPermission({ level: "full-access" });
      let release!: () => void;
      holdNextAnswer = new Promise<void>((resolve) => {
        release = resolve;
      });
      calls.push({
        name: "bash",
        args: {
          command: "sleep 0.2; echo busy-result",
          run_in_background: true,
        },
      });
      const prompt = await client.submitPromptAccepted(
        "start and keep working",
      );
      try {
        await vi.waitFor(
          () => {
            const row = getDatabase()
              .prepare<{
                result_ready_at: number | null;
              }>("SELECT result_ready_at FROM shell_job WHERE session_id=?")
              .get(prompt.sessionId);
            expect(typeof row?.result_ready_at).toBe("number");
          },
          { timeout: 5000 },
        );
        expect(
          getDatabase()
            .prepare<{
              count: number;
            }>(
              "SELECT count(*) AS count FROM run_ledger WHERE session_id=? AND trigger='background-task'",
            )
            .get(prompt.sessionId)?.count,
        ).toBe(0);
      } finally {
        release();
      }
      await client.waitForPrompt(prompt.promptId);
      await vi.waitFor(
        () => {
          expect(
            requests.some((request) =>
              JSON.stringify(request.messages).includes("busy-result"),
            ),
          ).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(
        getDatabase()
          .prepare<{
            count: number;
          }>(
            "SELECT count(*) AS count FROM run_ledger WHERE session_id=? AND trigger='background-task'",
          )
          .get(prompt.sessionId)?.count,
      ).toBe(0);
    },
  );

  it("recovers an unclaimed frozen batch at startup without waking for lost work", async () => {
    const { prompt } = await client.submitPromptAndWait("create a session");
    const store = new DatabaseShellJobStore({ db: getDatabase() });
    await store.insert(
      shellJobFixture({
        jobId: "startup-ready",
        sessionId: prompt.sessionId,
        rootSessionId: prompt.sessionId,
        status: "completed",
        cleanup: "confirmed",
        settledAt: 1,
        resultReadyAt: 1,
        noticeState: "pending",
        outputTail: "saved startup result",
      }),
    );
    const batch = await store.allocateNoticeBatch({
      sessionId: prompt.sessionId,
      contextScopeId: null,
    });
    await store.insert(
      shellJobFixture({
        jobId: "startup-lost",
        sessionId: prompt.sessionId,
        rootSessionId: prompt.sessionId,
        status: "lost",
        cleanup: "unconfirmed",
        settledAt: null,
        resultReadyAt: 2,
        noticeState: "pending",
        outputTail: "lost result",
      }),
    );
    await client.dispose();
    client = open();
    await client.initialize();
    await vi.waitFor(
      () => {
        const row = getDatabase()
          .prepare<{
            notice_wake_run_id: string | null;
          }>(
            "SELECT notice_wake_run_id FROM shell_job WHERE job_id='startup-ready'",
          )
          .get();
        expect(row?.notice_wake_run_id).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const received = store.getNoticeBatch(batch ?? "");
    expect(received[0]?.noticeWakeRunId).toBeTruthy();
    expect(store.get("startup-lost")?.noticeWakeRunId).toBeNull();
    await vi.waitFor(() => {
      expect(
        requests.some((request) =>
          JSON.stringify(request.messages).includes("saved startup result"),
        ),
      ).toBe(true);
    });
  });

  it("unsubscribes its background result listener during shutdown", async () => {
    // The original method is deliberately called with the mocked instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = DatabaseShellJobStore.prototype.subscribe;
    const unsubscribe = vi.fn();
    vi.spyOn(DatabaseShellJobStore.prototype, "subscribe").mockImplementation(
      function (this: DatabaseShellJobStore, listener) {
        const remove = original.call(this, listener);
        return () => {
          unsubscribe();
          remove();
        };
      },
    );
    peer = open();
    await peer.initialize();
    await peer.dispose();
    peer = undefined;
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("replays the same model prefix, MCP tools and cache key while keeping writes and selection scoped", async () => {
    calls.push({ name: "select_tools", args: { tools: [lookup] } });
    const first = await client.submitPromptAndWait("shared context one");
    expect(first.prompt.status).toBe("succeeded");
    const mainSessionId = first.prompt.sessionId;
    for (const text of ["shared context two", "shared context three"]) {
      expect(
        (await client.submitPromptAndWait(text, { sessionId: mainSessionId }))
          .prompt.status,
      ).toBe("succeeded");
    }
    const { sideChatId, boundaryMessageId } = await client.openSideChat({
      mainSessionId,
    });
    const sideView = (await client.getSnapshot()).sessions.find(
      (s) => s.id === sideChatId,
    );
    expect(sideView?.messages.at(-1)?.id).toBe(boundaryMessageId);
    const copy = await client.submitPromptAndWait("side question", {
      sessionId: sideChatId,
    });
    expect(copy.prompt.status).toBe("succeeded");
    expect(copy.prompt.sessionId).toBe(sideChatId);
    expect(await client.getSelectedSessionId()).toBe(mainSessionId);
    const side = requests.at(-1);
    if (!side) throw new Error("Expected a side chat request");
    expect(
      (
        await client.submitPromptAndWait("main follow-up", {
          sessionId: mainSessionId,
        })
      ).prompt.status,
    ).toBe("succeeded");
    const main = requests.at(-1);
    if (!main) throw new Error("Expected a main session request");
    expect(side.promptCache).toMatchObject({
      strategy: "openai-keyed-implicit",
    });
    expect(side.promptCache.key).toBeTypeOf("string");
    expect(side.promptCache).toEqual(main.promptCache);
    expect(side.tools).toEqual(main.tools);
    expect(main.tools?.map((t) => t.name)).toContain(lookup);
    const history = main.messages.slice(
      0,
      main.messages.findIndex((message) =>
        JSON.stringify(message.content).includes("main follow-up"),
      ),
    );
    expect(
      history.filter((m) => m.role === "assistant").length,
    ).toBeGreaterThanOrEqual(3);
    expect(side.messages.slice(0, history.length)).toEqual(history);
    expect(JSON.stringify(side.messages.at(-1))).toContain("side question");
    expect(JSON.stringify(main.messages)).not.toContain("side question");
    expect(await client.getSessionIndex()).toContainEqual(
      expect.objectContaining({ id: sideChatId, isSideChat: true }),
    );
    expect(listGlobalSessions().sessions.map((s) => s.id)).toEqual([
      mainSessionId,
    ]);
    expect(
      searchGlobalSessions({ query: "shared context" }).hits.map(
        (h) => h.session.id,
      ),
    ).toEqual([mainSessionId]);
    const events: import("ohbaby-sdk").UiEvent[] = [];
    client.subscribeEvents((event) => events.push(event));
    await client.executeCommand({
      commandId: "sessions",
      argv: [],
      clientInvocationId: crypto.randomUUID(),
      path: ["sessions"],
      raw: "/sessions",
      rawArgs: "",
      surface: "headless",
    });
    const result = events.find(
      (event) => event.type === "command.result.delivered",
    );
    expect(result?.output).toMatchObject({
      data: { sessions: [{ id: mainSessionId }] },
    });
  });

  it("rebuilds a second backend's view, usage, loaded MCP tools and both todo scopes after rewind", async () => {
    const [keptTool] = await McpManager.prototype.getAllTools();
    const dropped = "mcp_s7_example_t5_later";
    let finishLookup!: () => void;
    const lookupDone = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const lookupExecution = vi.fn<McpTool["execute"]>(async () => {
      await lookupDone;
      return { output: "lookup complete" };
    });
    const executeLater = vi.fn<McpTool["execute"]>(() =>
      Promise.resolve({ output: "later result" }),
    );
    vi.spyOn(McpManager.prototype, "getAllTools").mockResolvedValue([
      { ...keptTool, execute: lookupExecution },
      {
        ...keptTool,
        name: dropped,
        mcpToolName: "later",
        execute: executeLater,
      },
    ]);
    client.subscribePermissionEvents((event) => {
      if (event.type === "permission.requested")
        void client.respondPermission(
          event.request.id,
          { choiceId: "allow_once" },
          {
            permissionEpoch: event.permissionEpoch,
            rootSessionId: event.rootSessionId,
          },
        );
    });
    const scope = vi.spyOn(TodoWorkScopeRegistry.prototype, "resolve");
    function writeTodo(content: string): ToolCall {
      return {
        name: "todo_write",
        args: { todos: [{ content, status: "pending" }] },
      };
    }
    calls.push(writeTodo("kept default"));
    // The fixture's generated title equals the first prompt's temporary title.
    const first = (await client.submitPromptAndWait("Backend fixture reply"))
      .prompt;
    const { sessionId } = first;
    scope.mockReturnValue("goal:rewind-test");
    calls.push(
      { name: "select_tools", args: { tools: [lookup] } },
      writeTodo("kept goal"),
    );
    await client.submitPromptAndWait("second question", { sessionId });
    scope.mockReturnValue(undefined);
    calls.push(
      { name: "select_tools", args: { tools: [dropped] } },
      { name: dropped, args: {} },
      writeTodo("dropped default"),
    );
    const third = (
      await client.submitPromptAndWait("discarded-user-text ".repeat(800), {
        sessionId,
      })
    ).prompt;
    scope.mockReturnValue("goal:rewind-test");
    calls.push(writeTodo("dropped goal"));
    await client.submitPromptAndWait("fourth question", { sessionId });
    const usageBefore = await client.getContextWindowUsage({ sessionId });
    expect(executeLater).toHaveBeenCalledTimes(1);
    expect(requests.at(-1)?.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining([lookup, dropped]),
    );

    peer = open();
    await client.initializeSession(sessionId);
    const beforeView = await client.getSessionView?.({ sessionId });
    expect(beforeView?.session.messages.map((m) => m.id)).toContain(
      third.userMessageId,
    );
    calls.push({ name: lookup, args: {} });
    const live = client.submitPromptAndWait(
      "lookup while the peer attempts rewind",
      { sessionId },
    );
    try {
      await vi.waitFor(() => {
        expect(lookupExecution).toHaveBeenCalled();
      });
      await expect(
        peer.rewindSession({ sessionId, promptId: third.promptId }),
      ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
    } finally {
      finishLookup();
      expect((await live).prompt.status).toBe("succeeded");
    }
    await peer.rewindSession({ sessionId, promptId: third.promptId });
    const [view, history, usageAfter, snapshot] = await Promise.all([
      client.getSessionView?.({ sessionId }),
      client.getSessionHistory?.({ sessionId }),
      client.getContextWindowUsage({ sessionId }),
      client.getSnapshot(),
    ]);
    expect(view?.session.messages.map((m) => m.id)).toEqual(
      history?.messages.map((m) => m.id),
    );
    expect(view?.session.messages.map((m) => m.id)).not.toContain(
      third.userMessageId,
    );
    expect(view?.prompts.map((p) => p.promptId)).not.toContain(third.promptId);
    expect(view?.runs.map((r) => r.id)).not.toContain(third.runId);
    expect(
      snapshot.sessions
        .find((s) => s.id === sessionId)
        ?.messages.map((m) => m.id),
    ).not.toContain(third.userMessageId);
    expect(usageAfter?.currentTokens).toBeLessThan(
      usageBefore?.currentTokens ?? 0,
    );
    expect(
      snapshot.todos?.find((t) => t.sessionId === sessionId)?.todos,
    ).toEqual([{ content: "kept default", status: "pending" }]);
    calls.push({ name: "todo_read", args: {} }, { name: dropped, args: {} });
    await client.submitPromptAndWait("read the surviving goal list", {
      sessionId,
    });
    const sent = requests.at(-1);
    expect(sent?.tools?.map((t) => t.name)).toContain(lookup);
    expect(sent?.tools?.map((t) => t.name)).not.toContain(dropped);
    const sentMessages = JSON.stringify(sent?.messages);
    expect(sentMessages).toContain("kept goal");
    expect(sentMessages).not.toMatch(
      /discarded-user-text|dropped goal|dropped default/,
    );
    expect(sentMessages).toContain("MCP tool is not loaded");
    expect(executeLater).toHaveBeenCalledTimes(1);
    // The goal-scoped tool actually read the rebuilt cache, in addition to the retained history.
    const todoResult = sent?.messages.find(
      (m) => m.role === "tool" && m.callId.startsWith("todo_read-"),
    );
    expect(JSON.stringify(todoResult)).toContain("kept goal");

    await peer.rewindSession({ sessionId, promptId: first.promptId });
    expect(
      getDatabase()
        .prepare(
          "SELECT title, message_count, last_message_at FROM session WHERE id=?",
        )
        .get(sessionId),
    ).toEqual({
      title: "Backend fixture reply",
      message_count: 0,
      last_message_at: null,
    });
    const oldTitles = titleRequests;
    // Execute directly on the still-open backend without an intervening view read.
    calls.push({ name: "todo_read", args: {} });
    await client.submitPromptAndWait("a new subject", { sessionId });
    expect(titleRequests).toBe(oldTitles);
    expect(requests.at(-1)?.tools?.map((t) => t.name)).not.toContain(lookup);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toMatch(
      /kept goal|second question/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "leaves history visible on cleanup failure and retries after stopping the detached process",
    async () => {
      await client.setPermission({ level: "full-access" });
      calls.push({
        name: "bash",
        args: {
          command: "echo $$ > rewind-shell.pid; exec sleep 30",
          run_in_background: true,
        },
      });
      const { prompt } = await client.submitPromptAndWait(
        "start a background process",
      );
      const { runId, promptId, sessionId } = prompt;
      if (!runId) throw new Error("Expected a completed turn");
      const readPid = async (): Promise<number> =>
        Number(await readFile(join(directory, "rewind-shell.pid"), "utf8"));
      await expect.poll(readPid).toBeGreaterThan(1);
      const pid = await readPid();
      const executions = new DatabaseSubagentExecutionStore();
      const { record } = await executions.accept({
        executionId: "cut-execution",
        requestId: "call",
        parentSessionId: sessionId,
        requesterScopeId: "primary",
        requesterRunId: runId,
        rootSessionId: sessionId,
        rootRunId: runId,
        subagentId: "worker",
        mode: "foreground",
        prompt: "work",
        createdAt: 1,
      });
      await executions.finish(record, { status: "completed", completedAt: 2 });
      vi.spyOn(
        ShellJobRegistry.prototype,
        "stopByRootRun",
      ).mockResolvedValueOnce({ confirmed: false });
      await expect(
        client.rewindSession({ sessionId, promptId }),
      ).rejects.toMatchObject({
        code: "SHELL_JOB_CLEANUP_UNCONFIRMED",
        message: "Shell cleanup is unconfirmed",
      });
      for (const table of [
        "message",
        "prompt_submission",
        "subagent_execution",
      ]) {
        expect(
          getDatabase()
            .prepare(`SELECT 1 FROM ${table} WHERE rewound_at IS NOT NULL`)
            .get(),
        ).toBeUndefined();
      }
      expect(isOwnerProcessAlive(pid)).toBe(false);
      await client.rewindSession({ sessionId, promptId });
      expect(isOwnerProcessAlive(pid)).toBe(false);
      expect((await executions.get(record))?.rewoundAt).toBeDefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "records rewound when an active foreground bash is interrupted by rewind",
    async () => {
      await client.setPermission({ level: "full-access" });
      calls.push({
        name: "bash",
        args: { command: "echo $$ > foreground-rewind.pid; exec sleep 30" },
      });
      const prompt = await client.submitPromptAccepted("run foreground");
      const readPid = async (): Promise<number> =>
        Number(
          await readFile(join(directory, "foreground-rewind.pid"), "utf8"),
        );
      await expect.poll(readPid).toBeGreaterThan(1);
      await client.rewindSession({
        sessionId: prompt.sessionId,
        promptId: prompt.promptId,
      });
      const row = getDatabase()
        .prepare<{
          stop_reason: string;
          status: string;
        }>("SELECT stop_reason,status FROM shell_job WHERE session_id=?")
        .get(prompt.sessionId);
      expect(row).toMatchObject({
        stop_reason: "rewound",
        status: "cancelled",
      });
    },
  );

  it("forks at the selected answer and rebuilds tools, cache and scratch for the new session", async () => {
    client.subscribePermissionEvents((event) => {
      if (event.type === "permission.requested") {
        void client.respondPermission(
          event.request.id,
          { choiceId: "allow_once" },
          {
            permissionEpoch: event.permissionEpoch,
            rootSessionId: event.rootSessionId,
          },
        );
      }
    });
    const [baseTool] = await McpManager.prototype.getAllTools();
    const before = "mcp_s7_example_t6_before";
    const after = "mcp_s7_example_t5_after";
    const executeLookup = vi.fn<McpTool["execute"]>((args, context) =>
      Promise.resolve({
        output: `Lookup result from ${context.sessionId}: ${String(args.query)}`,
      }),
    );
    vi.spyOn(McpManager.prototype, "getAllTools").mockResolvedValue([
      {
        ...baseTool,
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        execute: executeLookup,
      },
      { ...baseTool, name: before, mcpToolName: "before" },
      { ...baseTool, name: after, mcpToolName: "after" },
    ]);
    calls.push(
      { name: "select_tools", args: { tools: [lookup, before] } },
      { name: lookup, args: { query: "source lookup" } },
      { name: before, args: {} },
    );
    const source = (await client.submitPromptAndWait("first question")).prompt
      .sessionId;
    const second = await client.submitPromptAndWait("second question", {
      sessionId: source,
    });
    const atCut = requests.at(-1);
    if (!atCut) throw new Error("Expected a request for the second turn");
    calls.push({ name: "select_tools", args: { tools: [after] } });
    await client.submitPromptAndWait("third question", { sessionId: source });
    const sourceTools = requests.at(-1)?.tools?.map((tool) => tool.name);
    expect(sourceTools).toEqual(
      expect.arrayContaining([lookup, before, after]),
    );

    expect(second.prompt.runId).toBeTruthy();
    const fork = await client.forkSession({
      sessionId: source,
      runId: second.prompt.runId,
    });
    expect(
      getDatabase()
        .prepare(
          "SELECT json_type(data, '$.sideChat') AS sideChat FROM session WHERE id=?",
        )
        .get(fork.sessionId),
    ).toEqual({ sideChat: null });
    expect(await client.getSelectedSessionId()).toBe(source);
    const snapshot = await client.getSnapshot();
    const original = snapshot.sessions.find((s) => s.id === source);
    const copied = snapshot.sessions.find((s) => s.id === fork.sessionId);
    if (!original || !copied)
      throw new Error("Expected both sessions in the snapshot");
    expect(
      copied.messages
        .map((m) => m.id)
        .some((id) => original.messages.some((m) => m.id === id)),
    ).toBe(false);
    expect(
      copied.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
        ),
    ).toEqual(["first question", "second question"]);
    const forkQuery = { query: "fork lookup" };
    calls.push({ name: lookup, args: forkQuery });
    const start = requests.length;
    expect(
      (
        await client.submitPromptAndWait("fork follow-up", {
          sessionId: fork.sessionId,
        })
      ).prompt.status,
    ).toBe("succeeded");
    const initial = requests[start];
    const forkTools = initial.tools?.map((t) => t.name);
    expect(forkTools).toEqual(atCut.tools?.map((t) => t.name));
    expect(forkTools).toEqual(expect.arrayContaining([lookup, before]));
    expect(forkTools).not.toContain(after);
    expect(initial.promptCache.key).toBeTypeOf("string");
    expect(initial.promptCache.key).not.toBe(atCut.promptCache.key);
    const sent = JSON.stringify(initial.messages);
    expect(sent).not.toContain("third question");
    const inheritedScratch = sent.indexOf(
      join(resolveSessionStorageDir(source), "scratch"),
    );
    expect(inheritedScratch).toBeGreaterThanOrEqual(0);
    expect(
      sent.lastIndexOf(
        join(resolveSessionStorageDir(fork.sessionId), "scratch"),
      ),
    ).toBeGreaterThan(inheritedScratch);
    expect(executeLookup).toHaveBeenCalledWith(
      forkQuery,
      expect.objectContaining({ sessionId: fork.sessionId }),
    );
    const result = requests.at(-1)?.messages.at(-1);
    expect(result?.role).toBe("tool");
    expect(result?.content).toContain(
      `Lookup result from ${fork.sessionId}: fork lookup`,
    );
    await client.submitPromptAndWait("list source tools after the fork", {
      sessionId: source,
    });
    expect(requests.at(-1)?.tools?.map((tool) => tool.name)).toEqual(
      sourceTools,
    );
    expect(
      (await client.getSessionIndex()).find((s) => s.id === fork.sessionId)
        ?.title,
    ).toBe(fork.title);
  });

  it("keeps fork approvals and storage independent while preserving paths in copied history", async () => {
    const shared = join(directory, "shared");
    await mkdir(shared);
    const approvals: string[] = [];
    let choiceId: "allow_always" | "allow_once" | "reject" = "allow_always";
    client.subscribePermissionEvents((event) => {
      if (event.type !== "permission.requested") return;
      approvals.push(event.request.description.split("(")[0]);
      void client.respondPermission(
        event.request.id,
        { choiceId },
        {
          permissionEpoch: event.permissionEpoch,
          rootSessionId: event.rootSessionId,
        },
      );
    });
    const write = {
      name: "write",
      args: { file_path: join(shared, "shared.txt"), content: "from source" },
    };
    calls.push(write);
    const source = (await client.submitPromptAndWait("allow this write")).prompt
      .sessionId;
    expect(approvals.splice(0)).toEqual(["write"]);
    const writeAndReadScratch = async (
      sessionId: string,
      content: string,
    ): Promise<string> => {
      const file_path = join(
        resolveSessionStorageDir(sessionId),
        "scratch",
        "local.txt",
      );
      calls.push(
        { name: "write", args: { file_path, content } },
        { name: "read", args: { file_path } },
      );
      const turn = await client.submitPromptAndWait(
        "write and read my scratch file",
        { sessionId },
      );
      expect(turn.prompt.status).toBe("succeeded");
      // The normal write-tool confirmation applies. Trusted scratch adds no external path request.
      expect(approvals.splice(0)).toEqual(["write"]);
      expect(await readFile(file_path, "utf8")).toBe(content);
      const readResult = requests.at(-1)?.messages.at(-1);
      expect(readResult?.role).toBe("tool");
      expect(readResult?.content).toContain(content);
      return file_path;
    };
    choiceId = "allow_once";
    const sourceScratch = await writeAndReadScratch(
      source,
      "source-only scratch",
    );
    const files = ["subagents", "tool-results"].map((dir) =>
      join(resolveSessionStorageDir(source), dir, "result.txt"),
    );
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "private source output ".repeat(3000));
    }
    await client.submitPromptAndWait(files.join(" "), { sessionId: source });
    const { sessionId } = await client.forkSession({ sessionId: source });
    choiceId = "reject";
    calls.push(
      { ...write, args: { ...write.args, content: "from fork" } },
      ...files.map((file_path) => ({ name: "read", args: { file_path } })),
    );
    await client.submitPromptAndWait(
      "try the same write and read the source results",
      { sessionId },
    );
    expect(approvals.splice(0)).toEqual([
      "write",
      "external_directory_read",
      "external_directory_read",
    ]);
    const sent = JSON.stringify(requests.at(-1)?.messages);
    for (const file of files) expect(sent).toContain(file);
    expect(sent).not.toContain("private source output");
    expect(await readFile(write.args.file_path, "utf8")).toBe("from source");
    choiceId = "allow_once";
    await writeAndReadScratch(sessionId, "fork-only scratch");
    expect(await readFile(sourceScratch, "utf8")).toBe("source-only scratch");
    choiceId = "reject";
    calls.push(write);
    await client.submitPromptAndWait("reuse source approval", {
      sessionId: source,
    });
    expect(approvals).toEqual([]);
  });

  it("automatically compacts the side chat with the main cache identity", async () => {
    const main = await client.submitPromptAndWait("background ".repeat(12000));
    const mainSessionId = main.prompt.sessionId;
    await client.submitPromptAndWait("another turn ".repeat(1000), {
      sessionId: mainSessionId,
    });
    const key = requests.at(-1)?.promptCache;
    const { sideChatId } = await client.openSideChat({ mainSessionId });
    overflowNext = true;
    const side = await client.submitPromptAndWait("continue after compaction", {
      sessionId: sideChatId,
    });
    expect(side.prompt).toMatchObject({ status: "succeeded" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].promptCache).toEqual(key);
    expect(summaries[0].sessionId).toBe(mainSessionId);
  });

  it("rejects restricted actions and uses the main scratch directory for ordinary tools", async () => {
    const main = await client.submitPromptAndWait("establish context");
    const mainSessionId = main.prompt.sessionId;
    const { sideChatId: sessionId } = await client.openSideChat({
      mainSessionId,
    });
    const unsupported = { code: "SIDE_CHAT_UNSUPPORTED" };
    await expect(client.compactSession({ sessionId })).rejects.toMatchObject(
      unsupported,
    );
    await expect(
      client.exportSession({ sessionId, format: "jsonl" }),
    ).rejects.toMatchObject(unsupported);
    await expect(
      client.updateSessionModel({ sessionId, modelEntryId: null }),
    ).rejects.toMatchObject(unsupported);
    await expect(
      client.updateSessionReasoning({ sessionId, reasoning: null }),
    ).rejects.toMatchObject(unsupported);
    await expect(client.archiveSession({ sessionId })).rejects.toMatchObject(
      unsupported,
    );
    await expect(
      client.openSideChat({ mainSessionId: sessionId }),
    ).rejects.toMatchObject(unsupported);
    await expect(
      client.executeCommand({
        commandId: "goal",
        argv: [],
        clientInvocationId: crypto.randomUUID(),
        path: ["goal"],
        raw: "/goal",
        rawArgs: "",
        sessionId,
        surface: "headless",
      }),
    ).rejects.toMatchObject(unsupported);
    expect(() => planSessionWorkspaceMove(sessionId, directory)).toThrow(
      SideChatUnsupportedError,
    );
    const scratch = join(resolveSessionStorageDir(mainSessionId), "scratch");
    const sharedFile = join(scratch, "shared.txt");
    await writeFile(sharedFile, "scratch contents from main");
    calls.push(
      { name: "agent", args: { action: "list" } },
      { name: "CreateGoal", args: { objective: "prohibited goal" } },
      { name: "read", args: { file_path: sharedFile } },
      {
        name: "write",
        args: {
          file_path: join(scratch, "side.txt"),
          content: "written by side",
        },
      },
    );
    const approvals: string[] = [];
    client.subscribePermissionEvents((event) => {
      if (event.type === "permission.requested") {
        approvals.push(event.request.callId);
        void client.respondPermission(
          event.request.id,
          { choiceId: "allow_once" },
          {
            permissionEpoch: event.permissionEpoch,
            rootSessionId: event.rootSessionId,
          },
        );
      }
    });
    const reply = await client.submitPromptAndWait(
      "inspect and write shared scratch",
      { sessionId },
    );
    expect(reply.prompt.status).toBe("succeeded");
    expect(approvals.some((id) => id.startsWith("read-"))).toBe(false);
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain("Subagents are not available in side chat");
    expect(sent).toContain("Goals are not available in side chat");
    expect(sent).toContain("scratch contents from main");
    expect(
      getDatabase()
        .prepare("SELECT 1 FROM subagent_instance WHERE parent_session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
    await expect(
      stat(resolveSessionStorageDir(sessionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await client.closeSideChat({ sideChatId: sessionId });
    expect(await readFile(join(scratch, "side.txt"), "utf8")).toBe(
      "written by side",
    );
  });

  it("closes a running side chat and clears its view, todos and approvals", async () => {
    const mainSessionId = (await client.submitPromptAndWait("start")).prompt
      .sessionId;
    const { sideChatId: sessionId } = await client.openSideChat({
      mainSessionId,
    });
    for (const subdir of ["allowed", "pending"])
      await mkdir(join(directory, subdir));
    calls.push(
      {
        name: "todo_write",
        args: { todos: [{ content: "side task", status: "in_progress" }] },
      },
      ...["allowed", "pending"].map((dir) => ({
        name: "write",
        args: { file_path: dir + "/out", content: "test" },
      })),
    );
    const receipt = await client.submitPromptAccepted("use tools", {
      sessionId,
    });
    const completion = client.waitForPrompt(receipt.promptId);
    const approval = (
      await vi.waitFor(async () => {
        const pending = (
          await client.getPermissionSnapshot({ rootSessionId: sessionId })
        ).requests;
        expect(pending).toHaveLength(1);
        return pending;
      })
    )[0];
    await client.respondPermission(approval.id, { choiceId: "allow_always" });
    await vi.waitFor(async () => {
      const view = await client.getSnapshot();
      expect(
        view.permissions.some(
          (p) => p.sessionId === sessionId && p.id !== approval.id,
        ),
      ).toBe(true);
      expect(view.todos).toContainEqual(expect.objectContaining({ sessionId }));
      expect(view.permission?.sessionRules).toContainEqual(
        expect.objectContaining({ sessionId }),
      );
      expect(
        view.sessions.some((s) => s.id === sessionId && s.messages.length > 0),
      ).toBe(true);
    });
    await client.closeSideChat({ sideChatId: sessionId });
    expect((await completion).prompt.status).toBe("interrupted");
    const view = await client.getSnapshot();
    expect(view.sessions.map((s) => s.id)).toContain(mainSessionId);
    expect(view.sessions.map((s) => s.id)).not.toContain(sessionId);
    for (const entries of [
      view.permissions,
      view.todos,
      view.permission?.sessionRules,
    ])
      expect(entries ?? []).not.toContainEqual(
        expect.objectContaining({ sessionId }),
      );
  });

  it("inherits approvals and archives open side chats in their owning workspaces after a move", async () => {
    for (const subdir of ["shared", "private"])
      await mkdir(join(directory, subdir));
    const write = (dir: string): void => {
      calls.push({
        name: "write",
        args: { file_path: dir + "/a.txt", content: "test" },
      });
    };
    const waitApproval = (): Promise<
      import("ohbaby-sdk").UiPermissionRequest
    > =>
      vi.waitFor(async () => {
        const approval = (await client.getSnapshot()).permissions.at(0);
        if (!approval) throw new Error("Waiting for approval");
        return approval;
      });
    write("shared");
    const main = await client.submitPromptAccepted("main write");
    await client.respondPermission((await waitApproval()).id, {
      choiceId: "allow_always",
    });
    await client.waitForPrompt(main.promptId);
    const { sideChatId: sessionId } = await client.openSideChat({
      mainSessionId: main.sessionId,
    });
    write("shared");
    expect(
      (await client.submitPromptAndWait("repeat write", { sessionId })).prompt
        .status,
    ).toBe("succeeded");
    let sideShellPid: number | undefined;
    if (process.platform !== "win32") {
      calls.push({
        name: "bash",
        args: {
          command: "echo $$ > side-shell.pid; exec sleep 30",
          run_in_background: true,
        },
      });
      const shellPrompt = await client.submitPromptAccepted(
        "start side shell",
        { sessionId },
      );
      await client.respondPermission((await waitApproval()).id, {
        choiceId: "allow_once",
      });
      await client.waitForPrompt(shellPrompt.promptId);
      const readPid = async (): Promise<number> =>
        Number(await readFile(join(directory, "side-shell.pid"), "utf8"));
      await expect.poll(readPid).toBeGreaterThan(1);
      sideShellPid = await readPid();
    }
    write("private");
    const pending = await client.submitPromptAccepted("another write", {
      sessionId,
    });
    expect((await waitApproval()).sessionId).toBe(sessionId);
    const queued = await client.submitPromptAccepted("queued", { sessionId });
    const outcomes = Promise.all(
      [pending, queued].map((p) => client.waitForPrompt(p.promptId)),
    );
    const destination = join(directory, "new-workspace");
    await mkdir(destination);
    await commitSessionWorkspaceMove(
      planSessionWorkspaceMove(main.sessionId, destination),
    );
    const moved = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      workdir: destination,
      enableSnapshots: false,
      releaseSideChatShellInWorkspace: (_workingDirectory, sideChatId) => {
        client.releaseSideChatShell(sideChatId);
        return Promise.resolve();
      },
      preflightSideChatInWorkspace: (workingDirectory, sideChatId) => {
        expect(workingDirectory).toBe(directory);
        return client.preflightSideChatShell(sideChatId);
      },
      closeSideChatInWorkspace: (workingDirectory, sideChatId) => {
        expect(workingDirectory).toBe(directory);
        return client.closeSideChat({ sideChatId });
      },
    });
    try {
      const input = { mainSessionId: main.sessionId };
      const next = await moved.openSideChat(input);
      expect((await moved.listSideChats(input)).sideChats).toMatchObject([
        { sideChatId: sessionId, workingDirectory: directory },
        { sideChatId: next.sideChatId, workingDirectory: destination },
      ]);
      await moved.archiveSession({ sessionId: main.sessionId });
    } finally {
      await moved.dispose();
    }
    if (sideShellPid !== undefined)
      expect(isOwnerProcessAlive(sideShellPid)).toBe(false);
    expect((await outcomes).map((r) => r.prompt.status)).toEqual([
      "interrupted",
      "cancelled",
    ]);
    expect((await client.getSnapshot()).permissions).toHaveLength(0);
    await client.closeSideChat({ sideChatId: sessionId });
    await expect(
      client.submitPromptAccepted("after close", { sessionId }),
    ).rejects.toThrow();
  });

  it("reuses a closed side chat number and archives only the selected main session's side chats", async () => {
    const mainSessionId = (await client.submitPromptAndWait("first main"))
      .prompt.sessionId;
    const input = { mainSessionId };
    const first = await client.openSideChat(input);
    const second = await client.openSideChat(input);
    const more = await Promise.all([
      client.openSideChat(input),
      client.openSideChat(input),
    ]);
    const opened = [first, second, ...more];
    expect(new Set(opened.map((s) => s.sideChatId)).size).toBe(4);
    expect(opened.map((s) => s.title).sort()).toEqual([
      "Side chat 1",
      "Side chat 2",
      "Side chat 3",
      "Side chat 4",
    ]);
    await client.closeSideChat(second);
    expect(await client.openSideChat(input)).toMatchObject({
      title: "Side chat 2",
    });

    const otherMain = await client.createSession();
    await client.submitPromptAndWait("second main", {
      sessionId: otherMain.id,
    });
    const other = await client.openSideChat({ mainSessionId: otherMain.id });
    await client.archiveSession({ sessionId: mainSessionId });
    expect(
      (
        await client.listSideChats({ mainSessionId: otherMain.id })
      ).sideChats.map((s) => s.sideChatId),
    ).toEqual([other.sideChatId]);
    expect(
      getDatabase()
        .prepare(
          "SELECT id FROM session WHERE json_extract(data, '$.sideChat.mainSessionId')=?",
        )
        .all(mainSessionId),
    ).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "does not stop main jobs when a side chat has a foreign owner",
    async () => {
      await client.setPermission({ level: "full-access" });
      calls.push({
        name: "bash",
        args: {
          command: "echo $$ > preflight-shell.pid; exec sleep 30",
          run_in_background: true,
        },
      });
      const mainSessionId = (
        await client.submitPromptAndWait("start main shell")
      ).prompt.sessionId;
      const readPid = async (): Promise<number> =>
        Number(await readFile(join(directory, "preflight-shell.pid"), "utf8"));
      await expect.poll(readPid).toBeGreaterThan(1);
      const pid = await readPid();
      const side = await client.openSideChat({ mainSessionId });
      const db = getDatabase();
      const owner = db.prepare(
        "UPDATE session SET data = json_set(data, '$.sideChat.ownerId', ?) WHERE id = ?",
      );
      owner.run("foreign-owner", side.sideChatId);
      try {
        await expect(
          client.archiveSession({ sessionId: mainSessionId }),
        ).rejects.toMatchObject({ code: "SESSION_RUNNING" });
        expect(isOwnerProcessAlive(pid)).toBe(true);
      } finally {
        owner.run(processOwnerId, side.sideChatId);
        await client.archiveSession({ sessionId: mainSessionId });
      }
      expect(isOwnerProcessAlive(pid)).toBe(false);
    },
  );

  it("retains foreign-owned side chats, times out for a busy run and recovers it on next startup", async () => {
    const mainSessionId = (await client.submitPromptAndWait("hello")).prompt
      .sessionId;
    const side = await client.openSideChat({ mainSessionId });
    const db = getDatabase();
    const owner = db.prepare(
      "UPDATE session SET data = json_set(data, '$.sideChat.ownerId', ?) WHERE id = ?",
    );
    owner.run("previous-process", side.sideChatId);
    const busy = { code: "SESSION_RUNNING" };
    await expect(client.closeSideChat(side)).rejects.toMatchObject(busy);
    await expect(
      client.archiveSession({ sessionId: mainSessionId }),
    ).rejects.toMatchObject(busy);
    owner.run(processOwnerId, side.sideChatId);
    db.prepare(
      "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at) VALUES ('busy',?,'user','running',1)",
    ).run(side.sideChatId);
    await expect(client.closeSideChat(side)).rejects.toMatchObject(busy);
    expect(
      (await client.listSideChats({ mainSessionId })).sideChats,
    ).toHaveLength(1);
    // The previous process has exited; the next process received its PID.
    owner.run("previous-process", side.sideChatId);
    await client.dispose();
    client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      workdir: directory,
    });
    await client.initialize();
    expect(
      db.prepare("SELECT id FROM session WHERE id=?").get(side.sideChatId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT run_id FROM run_ledger WHERE run_id='busy'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM session WHERE id=?").get(mainSessionId),
    ).toBeDefined();
  }, 15000);
});
