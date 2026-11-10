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
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { McpManager } from "../mcp/index.js";
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

describe("side chat through the persistent backend", () => {
  let directory: string;
  let client: PersistentUiBackendClient;
  const requests: InterfaceProviderRequest[] = [];
  const calls: ToolCall[] = [];
  const summaries: InterfaceProviderRequest[] = [];
  let overflowNext = false;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "side-chat-runtime-"));
    vi.stubEnv("OHBABY_HOME", join(directory, "home"));
    calls.length = 0;
    summaries.length = 0;
    overflowNext = false;
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
    client = createPersistentUiBackendClient({
      dbPath: join(directory, "agent.db"),
      workdir: directory,
      llmClient,
      enableSnapshots: false,
    });
  });

  afterEach(async () => {
    await client.dispose();
    closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
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

  it("retains foreign-owned side chats and times out safely for a run it cannot abort", async () => {
    const mainSessionId = (await client.submitPromptAndWait("hello")).prompt
      .sessionId;
    const side = await client.openSideChat({ mainSessionId });
    const db = getDatabase();
    const owner = db.prepare(
      "UPDATE session SET data = json_set(data, '$.sideChat.ownerPid', ?) WHERE id = ?",
    );
    owner.run(process.pid + 1, side.sideChatId);
    const busy = { code: "SESSION_RUNNING" };
    await expect(client.closeSideChat(side)).rejects.toMatchObject(busy);
    await expect(
      client.archiveSession({ sessionId: mainSessionId }),
    ).rejects.toMatchObject(busy);
    owner.run(process.pid, side.sideChatId);
    db.prepare(
      "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at) VALUES ('busy',?,'user','running',1)",
    ).run(side.sideChatId);
    await expect(client.closeSideChat(side)).rejects.toMatchObject(busy);
    expect(
      (await client.listSideChats({ mainSessionId })).sideChats,
    ).toHaveLength(1);
  }, 15000);
});
