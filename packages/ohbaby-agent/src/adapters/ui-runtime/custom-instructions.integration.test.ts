import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, AgentRegistry } from "../../agents/index.js";
import { createBus } from "../../bus/index.js";
import type { AgentsConfig } from "../../config/agents/index.js";
import type { LLMClientInstance } from "ohbaby-llm";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createAnthropicProvider } from "ohbaby-llm";
import { createOpenAICompatibleProvider } from "ohbaby-llm";
import { createOpenAIResponsesProvider } from "ohbaby-llm";
import { SkillRegistry } from "../../skill/index.js";
import { createUiRuntimeComposition } from "./composition.js";
import { createHostLocalSandboxManager } from "./host-local-environment.js";

const protocols = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
] as const;
type Protocol = (typeof protocols)[number];
type WireRequest = Record<string, unknown>;

const delegateArguments = JSON.stringify({
  role: "explore",
  mode: "foreground",
  prompt: "Inspect the delegated task and report done.",
});

// Script HTTP responses while the real SDK, wire adapter and runtime execute.
function reply(protocol: Protocol, delegate: boolean): Response {
  let events: Record<string, unknown>[];
  if (protocol === "openai-compatible") {
    events = [
      {
        id: "chat_instructions",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [
          {
            index: 0,
            delta: delegate
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_delegate",
                      type: "function",
                      function: {
                        name: "subagent_run",
                        arguments: delegateArguments,
                      },
                    },
                  ],
                }
              : { content: "done" },
            finish_reason: delegate ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      },
    ];
  } else if (protocol === "anthropic") {
    events = [
      {
        type: "message_start",
        message: {
          id: "msg_instructions",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: delegate
          ? {
              type: "tool_use",
              id: "call_delegate",
              name: "subagent_run",
              input: {},
            }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: delegate
          ? { type: "input_json_delta", partial_json: delegateArguments }
          : { type: "text_delta", text: "done" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: delegate ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 10 },
      },
      { type: "message_stop" },
    ];
  } else {
    const part = {
      type: "output_text",
      text: "done",
      annotations: [],
      logprobs: [],
    };
    const item = delegate
      ? {
          id: "item_delegate",
          type: "function_call",
          call_id: "call_delegate",
          name: "subagent_run",
          arguments: delegateArguments,
          status: "completed",
        }
      : {
          id: "msg_instructions",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [part],
        };
    const ref = { item_id: item.id, output_index: 0 };
    events = [
      {
        type: "response.output_item.added",
        ...ref,
        item: {
          ...item,
          status: "in_progress",
          ...(delegate ? { arguments: "" } : { content: [] }),
        },
      },
      ...(delegate
        ? [
            {
              type: "response.function_call_arguments.delta",
              ...ref,
              delta: delegateArguments,
            },
            {
              type: "response.function_call_arguments.done",
              ...ref,
              arguments: delegateArguments,
            },
          ]
        : [
            {
              type: "response.content_part.added",
              ...ref,
              content_index: 0,
              part: { ...part, text: "" },
            },
            {
              type: "response.output_text.delta",
              ...ref,
              content_index: 0,
              delta: "done",
              logprobs: [],
            },
            {
              type: "response.output_text.done",
              ...ref,
              content_index: 0,
              text: "done",
              logprobs: [],
            },
            {
              type: "response.content_part.done",
              ...ref,
              content_index: 0,
              part,
            },
          ]),
      { type: "response.output_item.done", ...ref, item },
      {
        type: "response.completed",
        response: {
          id: "resp_instructions",
          status: "completed",
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          previous_response_id: null,
          store: false,
        },
      },
    ];
  }
  return new Response(
    events
      .map(
        (event) =>
          `${protocol === "anthropic" ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function client(protocol: Protocol): LLMClientInstance {
  const createProvider =
    protocol === "anthropic"
      ? createAnthropicProvider
      : protocol === "openai-responses"
        ? createOpenAIResponsesProvider
        : createOpenAICompatibleProvider;
  return {
    provider: createProvider({
      id: "instruction-fixture",
      apiKey: "local-fixture-only",
      baseUrl: "https://instruction-fixture.invalid/v1",
    }),
    config: {
      provider: "instruction-fixture",
      model: "fixture",
      interfaceProvider: protocol,
      baseUrl: "https://instruction-fixture.invalid/v1",
      maxTokens: 128,
      promptCache: "disabled",
      modelProfiles: [
        {
          model: "fixture",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
  };
}

function systemText(protocol: Protocol, body: WireRequest): string {
  if (protocol === "openai-responses") return body.instructions as string;
  if (protocol === "anthropic") {
    return typeof body.system === "string"
      ? body.system
      : (body.system as { text: string }[])
          .map((block) => block.text)
          .join("\n\n");
  }
  return (
    (body.messages as { role: string; content: string }[]).find(
      (message) => message.role === "system",
    )?.content ?? ""
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(protocols)(
  "custom instructions in %s final HTTP requests",
  (protocol) => {
    it("loads session-root instructions for primary and child runs and refreshes only on a new run", async () => {
      const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "ohbaby-instructions-wire-")),
      );
      const projectRoot = path.join(root, "project");
      const workdir = path.join(projectRoot, "nested", "workdir");
      const home = path.join(root, "home");
      const globalDirectory = path.join(home, ".ohbaby");
      await mkdir(workdir, { recursive: true });
      await mkdir(globalDirectory, { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.stubEnv("OHBABY_HOME", globalDirectory);
      vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
      vi.stubEnv("APPDATA", path.join(home, "AppData"));
      const updateInstructions = async (version: number): Promise<void> => {
        await Promise.all([
          writeFile(
            path.join(projectRoot, "AGENTS.md"),
            `PROJECT_RULE_V${String(version)}`,
            "utf8",
          ),
          writeFile(
            path.join(globalDirectory, "CLAUDE.md"),
            `GLOBAL_RULE_V${String(version)}`,
            "utf8",
          ),
        ]);
      };
      await updateInstructions(1);
      await writeFile(
        path.join(workdir, "OHBABY.md"),
        "WRONG_WORKDIR_RULE",
        "utf8",
      );
      const requests: WireRequest[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
          const request = new Request(input, init);
          expect(new URL(request.url).hostname).toBe(
            "instruction-fixture.invalid",
          );
          requests.push((await request.json()) as WireRequest);
          const delegate = requests.length === 1;
          // The parent snapshot already exists. Its child and later runs must read V2.
          if (delegate) await updateInstructions(2);
          return reply(protocol, delegate);
        }),
      );
      const bus = createBus();
      const sandboxManager = createHostLocalSandboxManager(projectRoot);
      const acquire = sandboxManager.acquire.bind(sandboxManager);
      // A host sandbox may execute tools below the session's project boundary.
      // Children inherit this actual tool environment through subagent_run.
      vi.spyOn(sandboxManager, "acquire").mockImplementation((input) =>
        acquire(
          typeof input === "string"
            ? { sessionId: input, workdir }
            : input.contextScopeId === undefined
              ? { ...input, workdir }
              : input,
        ),
      );
      const composition = await createUiRuntimeComposition({
        agentManager: new AgentManager({
          registry: new AgentRegistry({
            configLoader: (): AgentsConfig => ({ agents: {} }),
          }),
        }),
        bus,
        llmClient: client(protocol),
        messageManager: createMessageManager({
          bus,
          store: createInMemoryMessageStore(),
        }),
        permissionState: createPermissionState({ bus }),
        sandboxManager,
        skillRegistry: new SkillRegistry({
          loader: {
            loadContent: (): Promise<never> =>
              Promise.reject(new Error("No skills loaded")),
            scan: (): Promise<Map<string, never>> =>
              Promise.resolve(new Map<string, never>()),
          },
        }),
        mcpManager: { getAllTools: () => Promise.resolve([]) },
        goalExecutionControl: {
          interruptGoalExecution: () => Promise.resolve(),
        },
        resultStorageRoot: path.join(root, "results"),
        workdir: projectRoot,
      });
      try {
        for (const [index, prompt] of [
          "Delegate an inspection.",
          "Start the next run.",
        ].entries()) {
          const run = await composition.startSession({
            agentName: "build",
            sessionId: "instruction_parent",
            // Reopening an existing session must retain its saved project root.
            projectRoot: index === 0 ? projectRoot : workdir,
            prompt,
          });
          expect(
            await composition.runManager.waitForCompletion(run.runId),
          ).toMatchObject({
            status: "succeeded",
            finalResponse: "done",
          });
        }
        expect(requests).toHaveLength(4);
        const systems = requests.map((body) => systemText(protocol, body));
        for (const [index, system] of systems.entries()) {
          const version = index === 0 || index === 2 ? 1 : 2;
          expect(system.split(`PROJECT_RULE_V${String(version)}`)).toHaveLength(
            2,
          );
          expect(system.split(`GLOBAL_RULE_V${String(version)}`)).toHaveLength(
            2,
          );
          expect(system).not.toContain(`PROJECT_RULE_V${String(3 - version)}`);
          expect(system).not.toContain(`GLOBAL_RULE_V${String(3 - version)}`);
          expect(system.indexOf("## Global Instructions")).toBeLessThan(
            system.indexOf("## Project Instructions"),
          );
          expect(system).not.toContain("WRONG_WORKDIR_RULE");
          expect(system).not.toContain("<memory>");
        }
        expect(systems[2]).toBe(systems[0]);
        expect(systems[3]).not.toBe(systems[0]);
        expect(systems[1]).toContain("<subagent_base>");
        expect(systems[1]).toContain("Task: explore");
        expect(systems[1]).not.toContain("You are Lychee");
        expect(systems[1]).not.toContain("Subagent roles for subagent_run");
        expect(JSON.stringify(requests[1])).toContain(
          JSON.stringify(workdir).slice(1, -1),
        );
      } finally {
        await composition.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
