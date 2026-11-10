import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { createTestUiRuntimeComposition as createUiRuntimeComposition } from "../../../fixtures/runtime-model-fixtures.js";
import { AgentManager } from "../../../../packages/ohbaby-agent/src/agents/index.js";
import { createBus } from "../../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  type MessageManager,
} from "../../../../packages/ohbaby-agent/src/core/message/index.js";
import type { Tool } from "../../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { McpToolMenu } from "../../../../packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.js";
import { createPermissionState } from "../../../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../../../packages/ohbaby-agent/src/services/database/index.js";
import type { SkillRegistryPort } from "../../../../packages/ohbaby-agent/src/skill/index.js";

const SESSION_ID = "session_mcp";
const [A, B, C, D] = [
  "mcp_s6_server_t5_alpha",
  "mcp_s6_server_t4_beta",
  "mcp_s6_server_t5_gamma",
  "mcp_s6_server_t5_delta",
] as const;

function mcpTool(name: string): Tool & {
  readonly mcpServer: string;
  readonly mcpToolName: string;
} {
  return {
    category: "readonly",
    description: `MCP tool ${name}`,
    execute: () => ({ output: "ok" }),
    mcpServer: "server",
    mcpToolName: name.split("_").at(-1) ?? name,
    name,
    parametersJsonSchema: {
      properties: { value: { type: "string" } },
      type: "object",
    },
    source: "mcp",
  };
}

/** MCP server whose tool list the test can change, like a disconnect. */
function fakeMcpManager(initial: readonly string[]): {
  readonly port: {
    getAllTools(): Promise<readonly Tool[]>;
    onChange(listener: () => void | Promise<void>): () => void;
  };
  setTools(names: readonly string[]): Promise<void>;
} {
  let tools = initial.map(mcpTool);
  const listeners = new Set<() => void | Promise<void>>();
  return {
    port: {
      getAllTools: () => Promise.resolve(tools),
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async setTools(names) {
      tools = names.map(mcpTool);
      for (const listener of listeners) {
        await listener();
      }
    },
  };
}

function stream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncIterable<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
    for (const event of events) yield await Promise.resolve(event);
  })();
}

/** Each request takes the next scripted reply; an empty script answers "ok". */
function scriptedLlm(
  requests: InterfaceProviderRequest[],
  script: InterfaceProviderStreamEvent[][],
): LLMClientInstance {
  return {
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      modelProfiles: [
        {
          contextWindowTokens: 128000,
          model: "fake-model",
          reasoningCapabilities: {
            mode: "none",
            supportsDisabled: true,
            wire: "none",
          },
        },
      ],
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: {},
      id: "fake",
      isAbortError: () => false,
      kind: "openai-compatible",
      streamResponse(request) {
        requests.push(request);
        return Promise.resolve(
          stream(script.shift() ?? [{ finishReason: "stop", textDelta: "ok" }]),
        );
      },
    },
  };
}

function selectToolsCall(callId: string, tools: readonly string[]) {
  return [
    {
      finishReason: "tool_calls",
      toolCallDeltas: [
        {
          argumentsDelta: JSON.stringify({ tools }),
          id: callId,
          index: 0,
          name: "select_tools",
        },
      ],
    },
  ] satisfies InterfaceProviderStreamEvent[];
}

const emptySkills: SkillRegistryPort = {
  all: () => Promise.resolve([]),
  deregisterPlugin: () => undefined,
  get: () => Promise.resolve(undefined),
  invalidate: () => undefined,
  listModelInvocable: () => Promise.resolve([]),
  listNames: () => Promise.resolve([]),
  listUserInvocable: () => Promise.resolve([]),
  load: (name) => Promise.reject(new Error(`No skill ${name}`)),
  onChange: () => () => undefined,
  readResource: (name) => Promise.reject(new Error(`No skill ${name}`)),
  registerPluginSkills: () => undefined,
  reload: () => Promise.resolve(),
};

describe("loaded MCP tools rebuilt from SQLite history", () => {
  let directory: string;
  let messageManager: MessageManager;
  const compositions: Awaited<ReturnType<typeof createUiRuntimeComposition>>[] =
    [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ohbaby-mcp-loaded-"));
    initDatabase({ dbPath: join(directory, "agent.db") });
    getDatabase()
      .prepare(
        "INSERT INTO session (id, project_id, working_directory, title, status, created_at, updated_at, data) VALUES (?, 'project', ?, 'MCP', 'active', 1, 1, '{}')",
      )
      .run(SESSION_ID, directory);
    messageManager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    });
  });

  afterEach(async () => {
    for (const composition of compositions.splice(0)) {
      await composition.dispose();
    }
    closeDatabase();
    await rm(directory, { force: true, recursive: true });
  });

  /** A fresh composition over the same database simulates a daemon restart. */
  async function boot(
    mcp: ReturnType<typeof fakeMcpManager>,
    script: InterfaceProviderStreamEvent[][] = [],
  ): Promise<{
    readonly composition: Awaited<
      ReturnType<typeof createUiRuntimeComposition>
    >;
    readonly requests: InterfaceProviderRequest[];
    turn(prompt: string): Promise<void>;
  }> {
    const bus = createBus();
    const requests: InterfaceProviderRequest[] = [];
    const composition = await createUiRuntimeComposition({
      agentManager: new AgentManager(),
      bus,
      goalExecutionControl: {
        interruptGoalExecution: () => Promise.resolve(),
      },
      llmClient: scriptedLlm(requests, script),
      mcpManager: mcp.port,
      messageManager,
      permissionState: createPermissionState({ bus, initialMode: "auto" }),
      skillRegistry: emptySkills,
      workdir: directory,
    });
    compositions.push(composition);
    return {
      composition,
      requests,
      async turn(prompt) {
        const started = await composition.startSession({
          agentName: "build",
          projectRoot: directory,
          prompt,
          sessionId: SESSION_ID,
          triggerSource: "user",
        });
        await composition.runManager.waitForCompletion(started.runId);
      },
    };
  }

  function toolsJson(request: InterfaceProviderRequest | undefined): string {
    return JSON.stringify(request?.tools);
  }

  function mcpNames(request: InterfaceProviderRequest | undefined): string[] {
    return (request?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("mcp_s6_"));
  }

  async function loadInOrder(
    first: Awaited<ReturnType<typeof boot>>,
  ): Promise<void> {
    // C, A, B: load order deliberately differs from name order.
    await first.turn("load C");
    await first.turn("load A");
    await first.turn("load B");
  }

  function loadScript(): InterfaceProviderStreamEvent[][] {
    return [
      selectToolsCall("call_c", [C]),
      [{ finishReason: "stop", textDelta: "loaded C" }],
      selectToolsCall("call_a", [A]),
      [{ finishReason: "stop", textDelta: "loaded A" }],
      selectToolsCall("call_b", [B]),
      [{ finishReason: "stop", textDelta: "loaded B" }],
    ];
  }

  it("restores loaded tools, access, catalog and byte-identical order after a restart (T2, T11, T13)", async () => {
    const mcp = fakeMcpManager([A, B, C, D]);
    const first = await boot(mcp, loadScript());
    await loadInOrder(first);
    const beforeRestart = first.requests.at(-1);
    expect(mcpNames(beforeRestart)).toEqual([C, A, B]);
    // T13: B was appended last; everything before it is unchanged.
    const beforeB = first.requests.at(-3);
    expect(mcpNames(beforeB)).toEqual([C, A]);
    expect(beforeRestart?.tools?.slice(0, -1)).toEqual(beforeB?.tools);
    await first.composition.dispose();
    compositions.splice(0);

    const second = await boot(mcp);
    await second.turn("continue");
    const afterRestart = second.requests[0];

    expect(toolsJson(afterRestart)).toBe(toolsJson(beforeRestart));
    // The latest catalog reminder still lists only the never-loaded tool.
    const catalog = (await messageManager.listBySession(SESSION_ID))
      .flatMap((message) => message.parts)
      .filter((part) => part.metadata?.reminderType === "mcp-catalog")
      .at(-1);
    const catalogText = catalog?.type === "text" ? catalog.text : "";
    expect(catalogText).toContain(`- ${D}`);
    for (const name of [A, B, C]) {
      expect(catalogText).not.toContain(`- ${name}`);
    }
    const call = await second.composition.toolScheduler.execute({
      agentName: "build",
      callId: "call_after_restart",
      messageId: "message_after_restart",
      params: {},
      sessionId: SESSION_ID,
      toolName: A,
    });
    expect(JSON.stringify(call)).not.toContain("MCP tool is not loaded");
  });

  it("keeps loaded tools when their select_tools parts are compacted (T3)", async () => {
    const mcp = fakeMcpManager([A, B, C, D]);
    const first = await boot(mcp, loadScript());
    await loadInOrder(first);
    const beforeCompaction = first.requests.at(-1);

    // Compaction only stamps time.compacted on parts and never deletes them;
    // stamp the persisted select_tools parts the same way.
    const selectParts = (await messageManager.listBySession(SESSION_ID))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "select_tools");
    expect(selectParts).toHaveLength(3);
    for (const part of selectParts) {
      await messageManager.updatePart(part.id, { time: { compacted: 1 } });
    }
    const stamped = (await messageManager.listBySession(SESSION_ID))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && part.tool === "select_tools");
    expect(stamped.every((part) => part.time?.compacted === 1)).toBe(true);
    await first.composition.dispose();
    compositions.splice(0);

    const second = await boot(mcp);
    await second.turn("continue after compaction");

    expect(toolsJson(second.requests[0])).toBe(toolsJson(beforeCompaction));
  });

  it("returns a reconnected tool to its original position without reselecting it (T4, T12)", async () => {
    const mcp = fakeMcpManager([A, B, C, D]);
    const first = await boot(mcp, loadScript());
    await loadInOrder(first);
    const beforeDisconnect = first.requests.at(-1);

    await mcp.setTools([B, C, D]);
    await first.turn("A is gone");
    expect(mcpNames(first.requests.at(-1))).toEqual([C, B]);

    await mcp.setTools([D, B, C, A]);
    await first.turn("A is back");
    expect(toolsJson(first.requests.at(-1))).toBe(toolsJson(beforeDisconnect));
  });

  it("isolates the primary context from subagent scopes in SQLite (T8)", async () => {
    const write = async (
      contextScopeId: string | undefined,
      loaded: readonly string[],
    ): Promise<void> => {
      const message = await messageManager.createMessage({
        agent: "build",
        ...(contextScopeId === undefined ? {} : { contextScopeId }),
        role: "assistant",
        sessionId: SESSION_ID,
      });
      await messageManager.appendPart(message.id, {
        callId: `call_${contextScopeId ?? "primary"}`,
        state: {
          input: { tools: loaded },
          metadata: { mcpSelection: { loaded } },
          output: "",
          status: "completed",
        },
        tool: "select_tools",
        type: "tool",
      });
    };
    await write(undefined, [A]);
    await write("subagent_1", [B]);
    const menu = new McpToolMenu({ history: messageManager });
    menu.setAvailable([A, B]);
    const primary = { sessionId: SESSION_ID };
    const subagent = { contextScopeId: "subagent_1", sessionId: SESSION_ID };

    await menu.ensureLoaded(primary);
    await menu.ensureLoaded(subagent);

    expect([...menu.loadedNames(primary)]).toEqual([A]);
    expect([...menu.loadedNames(subagent)]).toEqual([B]);
  });
});
