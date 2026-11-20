import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
  LLMConfig,
  ReasoningConfig,
} from "ohbaby-llm";
import type { UiEvent, UiSubagentInstance } from "ohbaby-sdk";
import type { ModelEntry } from "../config/llm/model-document.js";
import { deleteModelEntry } from "../config/llm/writer.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

type Client = ReturnType<typeof createInProcessUiBackendClient>;
type Response = AsyncGenerator<InterfaceProviderStreamEvent>;
type ToolInput = Record<string, unknown>;
interface Call {
  config: LLMConfig;
  request: InterfaceProviderRequest;
}

const rootSessionId = "subagent-model-root";
let directory: string;
let client: Client;
let parentCalls: Call[];
let childCalls: Call[];
let events: UiEvent[];
let parentTools: Map<string, ToolInput[]>;
let childResponse: (call: Call) => Response;
let beforeClient: (config: LLMConfig) => Promise<void>;
let beforeParentTools: () => Promise<void>;

function entry(id: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    provider: id,
    model: `model-${id}`,
    baseUrl: `https://${id}.invalid/v1`,
    interfaceProvider: "openai-compatible",
    apiKeyEnv: "OHBABY_TEST_UNSET_SUBAGENT_KEY",
    maxOutputTokens: 8192,
    reasoningCapabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["low", "medium", "high"],
    },
    ...extra,
  };
}

function writeModels(
  subagentModel?: { entryId: string; reasoning?: ReasoningConfig },
  models = [entry("default"), entry("parent"), entry("child")],
): Promise<void> {
  return writeFile(
    join(directory, "model.json"),
    JSON.stringify({
      schemaVersion: 2,
      activeProfileId: "default",
      models,
      subagentModel,
    }),
  );
}

async function* respond(event: InterfaceProviderStreamEvent): Response {
  yield await Promise.resolve(event);
}

function toolCalls(inputs: ToolInput[], prefix: string): Response {
  return respond({
    finishReason: "tool_calls",
    toolCallDeltas: inputs.map((input, index) => ({
      index,
      id: `${prefix}-${String(index)}`,
      name: "agent",
      argumentsDelta: JSON.stringify(input),
    })),
  });
}

function spawn(
  name: string,
  role: "generic" | "explore" = "generic",
): ToolInput {
  return { action: "spawn", name, role, prompt: `Task for ${name}` };
}

function send(agentId: string, message: string): ToolInput {
  return { action: "send", agent_id: agentId, message };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function submit(prompt: string, ...inputs: ToolInput[]): Promise<void> {
  parentTools.set(prompt, inputs);
  const result = await client.submitPromptAndWait(prompt, {
    sessionId: rootSessionId,
    modelEntryId: "parent",
    reasoning: { enabled: true, effort: "high" },
  });
  expect(result.prompt.status).toBe("succeeded");
  expect(parentTools.has(prompt)).toBe(false);
}

async function completed(
  name: string,
  previousExecutionId?: string,
): Promise<UiSubagentInstance> {
  return vi.waitFor(async () => {
    const instance = await childInstance(name);
    expect(instance.latestExecutionId).toBeDefined();
    expect(instance.latestExecutionId).not.toBe(previousExecutionId);
    expect(instance.status).toBe("completed");
    expect(instance.currentExecutionId).toBeUndefined();
    return instance;
  });
}

async function childInstance(name: string): Promise<UiSubagentInstance> {
  const { instances } = await client.listSubagentInstances({ rootSessionId });
  const instance = instances.find((row) => row.displayName === name);
  if (!instance) throw new Error(`Missing subagent ${name}`);
  return instance;
}

function modelEfforts(calls: readonly Call[]): [string, string | undefined][] {
  return calls.map(({ config, request }) => [
    config.provider,
    request.reasoning?.effort,
  ]);
}

function warningKeys(): string[] {
  return events.flatMap((event) =>
    event.type === "notice.emitted" &&
    event.notice.level === "warning" &&
    event.notice.key !== undefined
      ? [event.notice.key]
      : [],
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "subagent-model-integration-"));
  vi.stubEnv("OHBABY_HOME", directory);
  vi.stubEnv("OHBABY_TEST_UNSET_SUBAGENT_KEY", undefined);
  parentCalls = [];
  childCalls = [];
  events = [];
  parentTools = new Map();
  beforeClient = (): Promise<void> => Promise.resolve();
  beforeParentTools = (): Promise<void> => Promise.resolve();
  childResponse = (): Response =>
    respond({ textDelta: "Child done", finishReason: "stop" });
  client = createInProcessUiBackendClient({
    workdir: directory,
    projectDirectory: directory,
    async createLLMClient(config): Promise<LLMClientInstance> {
      await beforeClient(config);
      return {
        config,
        provider: {
          id: config.provider,
          kind: config.interfaceProvider,
          client: {},
          isAbortError: () => false,
          async streamResponse(request): Promise<Response> {
            if (request.purpose !== "agent-step")
              return Promise.resolve(
                respond({
                  textDelta: "Subagent model test",
                  finishReason: "stop",
                }),
              );
            const call = { config, request };
            if (JSON.stringify(request.messages).includes("<subagent_base>")) {
              childCalls.push(call);
              return Promise.resolve(childResponse(call));
            }
            parentCalls.push(call);
            const user = request.messages.findLast(
              (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                parentTools.has(message.content),
            );
            const prompt =
              typeof user?.content === "string" ? user.content : undefined;
            const inputs =
              prompt === undefined ? undefined : parentTools.get(prompt);
            if (prompt !== undefined) parentTools.delete(prompt);
            if (inputs?.length) await beforeParentTools();
            return Promise.resolve(
              inputs?.length
                ? toolCalls(inputs, `parent-${String(parentCalls.length)}`)
                : respond({ textDelta: "Parent done", finishReason: "stop" }),
            );
          },
        },
      };
    },
  });
  client.subscribeEvents((event) => events.push(event));
});

afterEach(async () => {
  await client.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("routes every child role with its explicit effort without changing the parent", async () => {
  await writeModels({ entryId: "child", reasoning: { effort: "low" } }, [
    entry("default"),
    entry("parent"),
    entry("child", { maxOutputTokens: 2048, reasoning: { enabled: false } }),
  ]);
  await submit("Delegate work", spawn("General"), spawn("Explore", "explore"));
  await Promise.all([completed("General"), completed("Explore")]);
  expect(modelEfforts(childCalls)).toEqual([
    ["child", "low"],
    ["child", "low"],
  ]);
  expect(childCalls.map(({ config }) => config.modelProfiles?.[0]?.id)).toEqual(
    ["child", "child"],
  );
  expect(childCalls.map(({ request }) => request.maxTokens)).toEqual([
    2048, 2048,
  ]);
  expect(
    modelEfforts(parentCalls).every(
      ([model, effort]) => model === "parent" && effort === "high",
    ),
  ).toBe(true);
  expect(
    (await client.getSnapshot()).sessions.find(
      (session) => session.id === rootSessionId,
    )?.modelEntryId,
  ).toBe("parent");
});

it("uses the child entry default when no child effort is selected and inherits the parent when cleared", async () => {
  await writeModels({ entryId: "child" }, [
    entry("default"),
    entry("parent"),
    entry("child", { reasoning: { enabled: true, effort: "low" } }),
  ]);
  await submit("Delegate a default task", spawn("General"));
  const previous = await completed("General");
  await client.selectSubagentModel({ entryId: null });
  await submit(
    "Send to the idle child in Follow chat",
    send(previous.subagentId, "Follow chat continued"),
  );
  await completed("General", previous.latestExecutionId);
  expect(modelEfforts(childCalls)).toEqual([
    ["child", "low"],
    ["parent", "high"],
  ]);
});

it("keeps the parent model when the configured entry is missing", async () => {
  await writeModels({ entryId: "deleted" });
  await submit("Delegate with a deleted model", spawn("General"));
  await completed("General");
  expect(modelEfforts(childCalls)).toEqual([["parent", "high"]]);
});

it("continues with the pinned parent model when model settings become unreadable mid-turn", async () => {
  await writeModels();
  beforeParentTools = (): Promise<void> =>
    writeFile(join(directory, "model.json"), "{");
  await submit("Delegate while settings are unreadable", spawn("General"));
  await completed("General");
  expect(modelEfforts(childCalls)).toEqual([["parent", "high"]]);
  expect(warningKeys()).toContain("model:subagent-unavailable");
});

it("warns and follows the parent when the configured model needs setup", async () => {
  await writeModels(
    { entryId: "child", reasoning: { enabled: true, effort: "low" } },
    [
      entry("default"),
      entry("parent"),
      entry("child", { needsConfiguration: true }),
    ],
  );
  await submit("Delegate with an incomplete model", spawn("General"));
  await completed("General");
  expect(modelEfforts(childCalls)).toEqual([["parent", "high"]]);
  expect(warningKeys()).toContain("model:subagent-unavailable");
});

it("uses the child model default when a stored effort becomes incompatible", async () => {
  await writeModels(
    { entryId: "child", reasoning: { enabled: true, effort: "obsolete" } },
    [
      entry("default"),
      entry("parent"),
      entry("child", { reasoning: { effort: "low" } }),
    ],
  );
  await submit("Delegate after a capability change", spawn("General"));
  await completed("General");
  expect(modelEfforts(childCalls)).toEqual([["child", "low"]]);
  expect(warningKeys()).toContain("model:subagent-reasoning-fallback");
});

it("keeps live sends on the current model and switches idle sends with their completed tool history", async () => {
  await writeModels(
    { entryId: "child", reasoning: { enabled: true, effort: "low" } },
    [
      entry("default"),
      entry("parent"),
      entry("child", { interfaceProvider: "openai-responses" }),
      entry("next"),
    ],
  );
  await writeFile(
    join(directory, "native-proof.txt"),
    "Tool history remains usable",
  );
  const release = deferred();
  childResponse = (): Response =>
    childCalls.length === 1
      ? (async function* (): Response {
          await release.promise;
          yield {
            finishReason: "tool_calls",
            textDelta: "Checking the directory.",
            toolCallDeltas: [
              {
                index: 0,
                id: "call_child_list",
                name: "list",
                argumentsDelta: "{}",
              },
            ],
            nativeOutput: {
              protocol: "openai-responses",
              items: [
                {
                  type: "reasoning",
                  id: "rs_child",
                  summary: [],
                  encrypted_content: "old-provider-state",
                },
                {
                  type: "message",
                  id: "msg_child",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Checking the directory.",
                      annotations: [],
                    },
                  ],
                },
                {
                  type: "function_call",
                  id: "fc_child",
                  call_id: "call_child_list",
                  name: "list",
                  arguments: "{}",
                  status: "completed",
                },
              ],
            },
          };
        })()
      : respond({ textDelta: "Child done", finishReason: "stop" });

  try {
    await submit(
      "Delegate before switching the configured model",
      spawn("Continuing"),
    );
    await vi.waitFor(() => {
      expect(childCalls).toHaveLength(1);
    });
    const running = await childInstance("Continuing");
    expect(running.currentExecutionId).toBeDefined();
    await client.selectSubagentModel({
      entryId: "next",
      reasoning: { enabled: true, effort: "medium" },
    });
    await submit(
      "Send to the running child",
      send(running.subagentId, "Live follow-up"),
    );
    expect(await childInstance("Continuing")).toMatchObject({
      currentExecutionId: running.currentExecutionId,
    });
    release.resolve();
    const finished = await completed("Continuing");
    expect(modelEfforts(childCalls)).toEqual([
      ["child", "low"],
      ["child", "low"],
    ]);
    expect(JSON.stringify(childCalls[1]?.request.messages)).toContain(
      "Live follow-up",
    );
    expect(JSON.stringify(childCalls[1]?.request.messages)).toContain(
      "old-provider-state",
    );

    await submit(
      "Send to the idle child",
      send(finished.subagentId, "Idle follow-up"),
    );
    await completed("Continuing", finished.latestExecutionId);
    const continued = childCalls[2].request.messages;
    const listResult = continued.find(
      (message) =>
        message.role === "tool" && message.callId === "call_child_list",
    );
    expect(listResult?.content).toContain("native-proof.txt");
    expect(JSON.stringify(continued)).not.toContain("old-provider-state");
    expect(JSON.stringify(continued)).toContain("Idle follow-up");

    await submit("Spawn with the new configuration", spawn("Fresh"));
    await completed("Fresh");
    expect(modelEfforts(childCalls)).toEqual([
      ["child", "low"],
      ["child", "low"],
      ["next", "medium"],
      ["next", "medium"],
    ]);
  } finally {
    release.resolve();
  }
});

it("keeps the admitted model when its entry is deleted during client creation", async () => {
  await writeModels({
    entryId: "child",
    reasoning: { enabled: true, effort: "low" },
  });
  const factoryEntered = vi.fn();
  const release = deferred();
  beforeClient = async ({ provider }): Promise<void> => {
    if (provider !== "child") return;
    factoryEntered();
    await release.promise;
  };

  try {
    await submit("Delegate before deleting the child model", spawn("First"));
    await vi.waitFor(() => {
      expect(factoryEntered).toHaveBeenCalledOnce();
    });
    const deletion = deleteModelEntry("child");
    const deleted = vi.fn();
    void deletion.then(deleted, deleted);
    await vi.waitFor(() => {
      expect(deleted).toHaveBeenCalledOnce();
    });
    expect(await deletion).toMatchObject({
      subagent: null,
      active: { id: "default" },
    });
    release.resolve();
    await completed("First");
    await submit("Delegate after deleting the child model", spawn("Second"));
    await completed("Second");
    expect(modelEfforts(childCalls)).toEqual([
      ["child", "low"],
      ["parent", "high"],
    ]);
  } finally {
    release.resolve();
  }
});
