import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LLMConfig,
  LLMClientInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";
import type { UiEvent } from "ohbaby-sdk";
import { createBus } from "../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type MessageManager,
} from "../core/message/index.js";
import type { ModelEntry } from "../config/llm/model-document.js";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";

type Client = ReturnType<typeof createInProcessUiBackendClient>;
interface Call {
  config: LLMConfig;
  request: InterfaceProviderRequest;
}
let root: string;
let home: string;
let clients: Client[];
let calls: Call[];
let beforeResponse: (call: Call) => Promise<void>;
const none = { mode: "none", wire: "none", supportsDisabled: true } as const;
const effort = {
  mode: "effort",
  wire: "openai",
  supportsDisabled: true,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
} as const;
function entry(id: string, extra: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    provider: id,
    model: `model-${id}`,
    baseUrl: `https://${id}.invalid/v1`,
    interfaceProvider: "openai-compatible",
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
    reasoningCapabilities: none,
    ...extra,
  };
}
async function writeModels(
  models: ModelEntry[],
  activeProfileId = "a",
): Promise<void> {
  await writeFile(
    join(home, "model.json"),
    JSON.stringify({ activeProfileId, models }),
  );
}
function createClient(
  directory = root,
  messageManager?: MessageManager,
): Client {
  const client = createInProcessUiBackendClient({
    workdir: directory,
    projectDirectory: directory,
    messageManager,
    createLLMClient: (config): Promise<LLMClientInstance> =>
      Promise.resolve({
        config,
        provider: {
          id: config.provider,
          kind: config.interfaceProvider,
          client: {},
          isAbortError: () => false,
          async streamResponse(
            request,
          ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
            const call = { config, request };
            calls.push(call);
            await beforeResponse(call);
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              await Promise.resolve();
              yield {
                textDelta:
                  request.purpose === "session-title"
                    ? "Selected model task"
                    : request.purpose === "context-summary"
                      ? "<state_snapshot>Keep the blue lantern requirement.</state_snapshot>"
                      : "The blue lantern remains required.",
                finishReason: "stop",
              };
            })();
          },
        },
      }),
  });
  clients.push(client);
  return client;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function agentCalls(): Call[] {
  return calls.filter((call) => call.request.purpose === "agent-step");
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-model-acceptance-"));
  home = join(root, "config");
  await mkdir(home);
  vi.stubEnv("OHBABY_HOME", home);
  clients = [];
  calls = [];
  beforeResponse = (): Promise<void> => Promise.resolve();
  await writeModels([entry("a"), entry("b")]);
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("T10 generates the first title using the same explicit entry as its turn", async () => {
  const client = createClient();
  const result = await client.submitPromptAndWait(
    "Explain the blue lantern requirement",
    { modelEntryId: "b" },
  );
  expect(result.prompt.status).toBe("succeeded");
  await vi.waitFor(() => {
    expect(
      calls.filter((call) => call.request.purpose === "session-title"),
    ).toHaveLength(1);
  });
  expect(
    calls
      .filter((call) => call.request.purpose === "session-title")
      .map((call) => [call.config.provider, call.config.baseUrl]),
  ).toEqual([["b", "https://b.invalid/v1"]]);
  expect(agentCalls().map((call) => call.config.provider)).toEqual(["b"]);
  await vi.waitFor(async () => {
    expect(
      (await client.getSnapshot()).sessions.find(
        (session) => session.id === result.prompt.sessionId,
      )?.title,
    ).toBe("Selected model task");
  });
});

it("T10 sends automatic and manual compression to the session entry rather than the default", async () => {
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  await writeModels([
    entry("a"),
    entry("b", { contextWindowTokens: 65536, maxOutputTokens: 30000 }),
  ]);
  const client = createClient(root, messages);
  const first = await client.submitPromptAndWait("Keep the blue lantern", {
    sessionId: "summary-session",
    modelEntryId: "b",
  });
  expect(first.prompt.status).toBe("succeeded");
  async function pressure(repetitions: number): Promise<void> {
    for (const role of ["user", "assistant", "user"] as const) {
      const message = await messages.createMessage({
        agent: "fixture",
        role,
        sessionId: "summary-session",
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: `Historical lantern requirement ${role} `.repeat(repetitions),
      });
    }
  }
  await pressure(4500);
  const second = await client.submitPromptAndWait("Continue with the lantern", {
    sessionId: "summary-session",
  });
  expect(second.prompt.status).toBe("succeeded");
  const summaries = (): Call[] =>
    calls.filter((call) => call.request.purpose === "context-summary");
  expect(summaries().length).toBeGreaterThan(0);
  const count = summaries().length;
  await pressure(1500);
  expect(
    await client.compactSession({ sessionId: "summary-session", force: true }),
  ).toMatchObject({ status: "compacted" });
  expect(summaries()).toHaveLength(count + 1);
  expect(
    summaries().every((call) => call.config.baseUrl === "https://b.invalid/v1"),
  ).toBe(true);
  expect(
    await client.getContextWindowUsage({ sessionId: "summary-session" }),
  ).toMatchObject({ contextWindowTokens: 65536 });
});

it("T13/T14 applies entry defaults and clears an incompatible session effort when switching", async () => {
  await writeModels([
    entry("a", {
      reasoning: { effort: "high" },
      reasoningCapabilities: {
        ...effort,
        efforts: ["low", "medium", "high", "xhigh"],
      },
    }),
    entry("b", { reasoningCapabilities: effort }),
  ]);
  const client = createClient();
  expect(
    (
      await client.submitPromptAndWait("Use entry A default", {
        sessionId: "reasoning-a",
        modelEntryId: "a",
      })
    ).prompt.status,
  ).toBe("succeeded");
  expect(
    (
      await client.submitPromptAndWait("Use entry B capability default", {
        sessionId: "reasoning-b",
        modelEntryId: "b",
      })
    ).prompt.status,
  ).toBe("succeeded");
  expect(agentCalls().map((call) => call.request.reasoning?.effort)).toEqual([
    "high",
    "medium",
  ]);
  await client.updateSessionReasoning({
    sessionId: "reasoning-a",
    reasoning: { effort: "xhigh" },
  });
  expect(
    await client.updateSessionModel({
      sessionId: "reasoning-a",
      modelEntryId: "b",
    }),
  ).toMatchObject({ modelEntryId: "b", reasoning: undefined });
  expect(
    (
      await client.submitPromptAndWait("Use B after switching", {
        sessionId: "reasoning-a",
      })
    ).prompt.status,
  ).toBe("succeeded");
  expect(agentCalls().at(-1)?.request.reasoning?.effort).toBe("medium");
});

it("T13 preserves a session effort when the target entry capability is still unknown", async () => {
  await writeModels([
    entry("a", {
      reasoningCapabilities: { ...effort, efforts: ["medium", "xhigh"] },
    }),
    entry("b", { reasoningCapabilities: undefined }),
  ]);
  const client = createClient();
  await client.submitPromptAndWait("Start reasoning session", {
    sessionId: "unknown-effort",
    modelEntryId: "a",
  });
  await client.updateSessionReasoning({
    sessionId: "unknown-effort",
    reasoning: { effort: "xhigh" },
  });
  expect(
    await client.updateSessionModel({
      sessionId: "unknown-effort",
      modelEntryId: "b",
    }),
  ).toMatchObject({ modelEntryId: "b", reasoning: { effort: "xhigh" } });
});

it("T6 resolves each workspace's key and refreshes edited credentials for its next turn", async () => {
  const keyName = "SESSION_MODEL_ACCEPTANCE_KEY";
  vi.stubEnv(keyName, undefined);
  const left = join(root, "left");
  const right = join(root, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(join(left, ".env"), `${keyName}=left-fixture\n`);
  await writeFile(join(right, ".env"), `${keyName}=right-fixture\n`);
  await writeModels([entry("a", { apiKeyEnv: keyName })]);
  const leftClient = createClient(left);
  const rightClient = createClient(right);
  expect(
    (
      await leftClient.submitPromptAndWait("Left workspace", {
        sessionId: "left",
      })
    ).prompt.status,
  ).toBe("succeeded");
  expect(
    (
      await rightClient.submitPromptAndWait("Right workspace", {
        sessionId: "right",
      })
    ).prompt.status,
  ).toBe("succeeded");
  await writeFile(join(left, ".env"), `${keyName}=left-updated-fixture\n`);
  expect(
    (await leftClient.submitPromptAndWait("Left again", { sessionId: "left" }))
      .prompt.status,
  ).toBe("succeeded");
  expect(agentCalls().map((call) => call.config.apiKey)).toEqual([
    "left-fixture",
    "right-fixture",
    "left-updated-fixture",
  ]);
});

it("T5 falls back for a deleted queued choice without clearing the session's newer selection", async () => {
  await writeModels([entry("a"), entry("b"), entry("c")]);
  const client = createClient();
  const events: UiEvent[] = [];
  client.subscribeEvents((event) => events.push(event));
  const entered = deferred();
  const release = deferred();
  let held = false;
  beforeResponse = async ({ request }): Promise<void> => {
    if (request.purpose === "agent-step" && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  try {
    const first = await client.submitPromptAccepted("First B turn", {
      sessionId: "deleted-queued",
      modelEntryId: "b",
    });
    await entered.promise;
    const queued = await client.submitPromptAccepted("Queued B turn", {
      sessionId: "deleted-queued",
    });
    await client.updateSessionModel({
      sessionId: "deleted-queued",
      modelEntryId: "c",
    });
    await writeModels([entry("a"), entry("c")]);
    release.resolve();
    expect((await client.waitForPrompt(first.promptId)).prompt.status).toBe(
      "succeeded",
    );
    expect((await client.waitForPrompt(queued.promptId)).prompt.status).toBe(
      "succeeded",
    );
    expect(
      (await client.getSnapshot()).sessions.find(
        (session) => session.id === "deleted-queued",
      )?.modelEntryId,
    ).toBe("c");
    expect(
      (
        await client.submitPromptAndWait("New C turn", {
          sessionId: "deleted-queued",
        })
      ).prompt.status,
    ).toBe("succeeded");
    expect(agentCalls().map((call) => call.config.provider)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "notice.emitted" &&
          event.notice.key === "model:entry-removed:deleted-queued",
      ),
    ).toBe(true);
  } finally {
    release.resolve();
  }
});

it("T13b filters a frozen effort against the default selected at queued execution", async () => {
  const models = [
    entry("a", {
      reasoningCapabilities: { ...effort, efforts: ["medium", "xhigh"] },
    }),
    entry("b", { reasoning: { effort: "low" }, reasoningCapabilities: effort }),
  ];
  await writeModels(models);
  const client = createClient();
  const events: UiEvent[] = [];
  client.subscribeEvents((event) => events.push(event));
  const entered = deferred();
  const release = deferred();
  let held = false;
  beforeResponse = async ({ request }): Promise<void> => {
    if (request.purpose === "agent-step" && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  try {
    const first = await client.submitPromptAccepted("First default turn", {
      sessionId: "reasoning-queue",
      reasoning: { effort: "xhigh" },
    });
    await entered.promise;
    const queued = await client.submitPromptAccepted("Queued default turn", {
      sessionId: "reasoning-queue",
    });
    await writeModels(models, "b");
    release.resolve();
    expect((await client.waitForPrompt(first.promptId)).prompt.status).toBe(
      "succeeded",
    );
    expect((await client.waitForPrompt(queued.promptId)).prompt.status).toBe(
      "succeeded",
    );
    expect(
      agentCalls().map((call) => [
        call.config.provider,
        call.request.reasoning?.effort,
      ]),
    ).toEqual([
      ["a", "xhigh"],
      ["b", "low"],
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "notice.emitted" &&
          event.notice.key === "model:reasoning-fallback:reasoning-queue",
      ),
    ).toBe(true);
  } finally {
    release.resolve();
  }
});

it("T25 lists complete entries for /models, marking the chat's model and the default", async () => {
  await writeModels([
    entry("a"),
    entry("b"),
    entry("c", { needsConfiguration: true }),
  ]);
  const client = createClient();
  const result = await client.submitPromptAndWait("Use B", {
    modelEntryId: "b",
  });
  const sessionId = result.prompt.sessionId;
  const events: UiEvent[] = [];
  client.subscribeEvents((event) => {
    events.push(event);
  });
  const run = async (id: string, session?: string): Promise<unknown> => {
    events.length = 0;
    await client.executeCommand({
      argv: [],
      clientInvocationId: id,
      commandId: "models",
      path: ["models"],
      raw: "/models",
      rawArgs: "",
      ...(session ? { sessionId: session } : {}),
      surface: "tui",
    });
    const delivered = events.find(
      (event) => event.type === "command.result.delivered",
    );
    return delivered?.type === "command.result.delivered"
      ? delivered.output
      : undefined;
  };
  const marks = (output: unknown): unknown =>
    (
      (output as { data: { models: { id: string }[] } }).data.models as {
        id: string;
        active?: boolean;
        default?: boolean;
      }[]
    ).map(({ id, active, default: isDefault }) => ({
      id,
      active,
      default: isDefault,
    }));
  expect(marks(await run("inv_session", sessionId))).toEqual([
    { id: "a", active: false, default: true },
    { id: "b", active: true, default: false },
  ]);
  expect(marks(await run("inv_draft"))).toEqual([
    { id: "a", active: true, default: true },
    { id: "b", active: false, default: false },
  ]);
  // A draft's choice resolves before it has a session.
  await expect(
    client.getCurrentModel({ modelEntryId: "b" }),
  ).resolves.toMatchObject({ id: "b", model: "model-b" });
});
