import * as composition from "./ui-runtime/composition.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import { setActiveLLMConfig } from "../config/llm/writer.js";
import type { LLMClientInstance } from "../core/llm-client/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../services/interface-providers/index.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shared model configuration admission", () => {
  it("keeps both workspaces' old two-tool loops on A, queues new work, and selects latest C independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-model-switch-"));
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    vi.stubGlobal("fetch", async () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
    );
    const modelPath = join(directory, ".ohbaby", "model.json");
    const gates = [deferred(), deferred()];
    const entered = [deferred(), deferred()];
    const calls: string[][] = [[], []];
    const input = {
      provider: "test",
      model: "A",
      baseUrl: "https://models.example/v1",
      interfaceProvider: "openai-compatible" as const,
      contextWindowTokens: 128000,
    };
    await setActiveLLMConfig({ ...input, modelJsonPath: modelPath });
    const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
    try {
      for (const workspace of [0, 1]) {
        const workdir = join(directory, `workspace-${String(workspace)}`);
        await mkdir(workdir);
        await writeFile(
          join(workdir, "note.txt"),
          "Remember the blue lantern.",
        );
        clients.push(
          createInProcessUiBackendClient({
            workdir,
            createLLMClient: async (): Promise<LLMClientInstance> => {
              const model = (
                JSON.parse(await readFile(modelPath, "utf8")) as {
                  defaultModel: string;
                }
              ).defaultModel;
              let turn = 0;
              return {
                config: {
                  provider: "test",
                  model,
                  baseUrl: input.baseUrl,
                  interfaceProvider: "openai-compatible",
                  temperature: 0,
                  maxTokens: 128,
                  modelProfiles: [
                    {
                      model,
                      contextWindowTokens: 128000,
                      reasoningCapabilities: {
                        mode: "none",
                        wire: "none",
                        supportsDisabled: true,
                      },
                    },
                  ],
                },
                provider: {
                  id: "test",
                  kind: "openai-compatible",
                  client: {},
                  isAbortError: () => false,
                  streamResponse(
                    request: InterfaceProviderRequest,
                  ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
                    if (
                      JSON.stringify(request).includes(
                        "Generate a concise title for a coding-agent chat session.",
                      )
                    )
                      return Promise.resolve(
                        (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                          await Promise.resolve();
                          yield {
                            textDelta: "Title",
                            finishReason: "stop" as const,
                          };
                        })(),
                      );
                    calls[workspace].push(model);
                    const currentTurn = ++turn;
                    return Promise.resolve(
                      (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                        if (model === "A" && currentTurn === 1) {
                          entered[workspace].resolve();
                          await gates[workspace].promise;
                        }
                        if (model === "A" && currentTurn <= 2)
                          yield {
                            toolCallDeltas: [
                              {
                                id: `read-${String(currentTurn)}`,
                                index: 0,
                                name: "read",
                                argumentsDelta: JSON.stringify({
                                  file_path: join(workdir, "note.txt"),
                                }),
                              },
                            ],
                            finishReason: "tool_calls" as const,
                          };
                        else
                          yield {
                            textDelta: `${model} done`,
                            finishReason: "stop" as const,
                          };
                      })(),
                    );
                  },
                },
              };
            },
          }),
        );
      }
      const old = clients.map((client) =>
        client.submitPromptAndWait("Read note.txt twice", { sessionId: "old" }),
      );
      await Promise.all(entered.map((entry) => entry.promise));
      expect(
        (await clients[0].connectModel({ ...input, model: "B" })).saved,
      ).toBe(true);
      const waiting = await clients[0].submitPromptAccepted(
        "Use the saved model",
        { sessionId: "new", clientRequestId: "new-work" },
      );
      const cancelled = await clients[1].submitPromptAccepted(
        "Cancel while waiting",
        { sessionId: "cancel", clientRequestId: "cancel-work" },
      );
      await vi.waitFor(async () => {
        expect(
          (await clients[0].getSnapshot()).prompts?.some(
            (p) => p.promptId === waiting.promptId,
          ),
        ).toBe(true);
      });
      await clients[1].cancelQueuedPrompt({ promptId: cancelled.promptId });
      await clients[1].connectModel({ ...input, model: "C" });
      expect(calls).toEqual([["A"], ["A"]]);
      gates[0].resolve();
      await old[0];
      await clients[0].waitForPrompt(waiting.promptId);
      await vi.waitFor(() => {
        expect(calls[0]).toEqual(["A", "A", "A", "C"]);
      });
      expect(calls[1]).toEqual(["A"]);
      gates[1].resolve();
      await old[1];
      const next = await clients[1].submitPromptAndWait("Now use latest", {
        sessionId: "next",
      });
      expect(next.prompt.status).toBe("succeeded");
      expect(calls[1]).toEqual(["A", "A", "A", "C"]);
    } finally {
      gates.forEach((gate) => {
        gate.resolve();
      });
      await Promise.all(clients.map((client) => client.dispose()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("waits for a real background shell before manual summary and keeps its model until summary settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-summary-switch-"));
    vi.stubEnv("HOME", directory);
    vi.stubEnv("USERPROFILE", directory);
    vi.stubGlobal(
      "fetch",
      (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
    );
    const workdir = join(directory, "workspace");
    await mkdir(workdir);
    const modelPath = join(directory, ".ohbaby", "model.json");
    const input = {
      provider: "test",
      model: "A",
      baseUrl: "https://models.example/v1",
      interfaceProvider: "openai-compatible" as const,
      contextWindowTokens: 128000,
    };
    await setActiveLLMConfig({ ...input, modelJsonPath: modelPath });
    const summaryStarted = deferred();
    const releaseSummary = deferred();
    const summaryModels: string[] = [];
    const disposed: string[] = [];
    const activities: (() => readonly string[])[] = [];
    const makeComposition = composition.createUiRuntimeComposition;
    const compositionSpy = vi
      .spyOn(composition, "createUiRuntimeComposition")
      .mockImplementation(async (options) => {
        const runtime = await makeComposition(options);
        const model = options.llmClient.config.model;
        activities.push(() => runtime.getActivityReasons());
        return {
          ...runtime,
          dispose: async (): Promise<void> => {
            disposed.push(model);
            await runtime.dispose();
          },
          compactSession: async (
            compactInput,
          ): ReturnType<typeof runtime.compactSession> => {
            summaryModels.push(model);
            return runtime.compactSession(compactInput);
          },
        };
      });
    const client = createInProcessUiBackendClient({
      workdir,
      createLLMClient: async (): Promise<LLMClientInstance> => {
        const model = (
          JSON.parse(await readFile(modelPath, "utf8")) as {
            defaultModel: string;
          }
        ).defaultModel;
        let turn = 0;
        return {
          config: {
            provider: "test",
            model,
            baseUrl: input.baseUrl,
            interfaceProvider: "openai-compatible",
            temperature: 0,
            maxTokens: 128,
            modelProfiles: [
              {
                model,
                contextWindowTokens: 128000,
                reasoningCapabilities: {
                  mode: "none",
                  wire: "none",
                  supportsDisabled: true,
                },
              },
            ],
          },
          provider: {
            id: "test",
            kind: "openai-compatible",
            client: {},
            isAbortError: (): boolean => false,
            streamResponse(
              request: InterfaceProviderRequest,
            ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
              const title = JSON.stringify(request).includes(
                "Generate a concise title for a coding-agent chat session.",
              );
              const currentTurn = title ? 0 : ++turn;
              return Promise.resolve(
                (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                  await Promise.resolve();
                  if (title) {
                    yield { textDelta: "Title", finishReason: "stop" };
                    return;
                  }
                  if (model === "A" && currentTurn === 1) {
                    yield {
                      toolCallDeltas: [
                        {
                          id: "background-shell",
                          index: 0,
                          name: "bash",
                          argumentsDelta: JSON.stringify({
                            command:
                              "while [ ! -f .release-background ]; do sleep 0.02; done",
                            run_in_background: true,
                            timeout: 10000,
                          }),
                        },
                      ],
                      finishReason: "tool_calls",
                    };
                  } else if (model === "B") {
                    summaryStarted.resolve();
                    await releaseSummary.promise;
                    yield {
                      textDelta:
                        "<state_snapshot>The background job finished. Preserve the blue lantern fact.</state_snapshot>",
                      finishReason: "stop",
                    };
                  } else
                    yield {
                      textDelta: "The blue lantern is important. ".repeat(30),
                      finishReason: "stop",
                    };
                })(),
              );
            },
          },
        };
      },
    });
    const waitingNotices: string[] = [];
    client.subscribeEvents((event) => {
      if (event.type === "permission.requested")
        void client.respondPermission(event.request.id, {
          choiceId: "allow_once",
        });
      if (
        event.type === "notice.emitted" &&
        event.notice.key === "runtime:model-switch"
      )
        waitingNotices.push(event.notice.message);
    });
    let summary: ReturnType<typeof client.compactSession> | undefined;
    try {
      expect(
        (
          await client.submitPromptAndWait(
            "Start a background shell and preserve the blue lantern fact.",
            { sessionId: "session" },
          )
        ).prompt.status,
      ).toBe("succeeded");
      expect(
        (
          await client.submitPromptAndWait(
            "Remember that fact for the next turn.",
            { sessionId: "session" },
          )
        ).prompt.status,
      ).toBe("succeeded");
      expect((await client.getSnapshot()).status.kind).toBe("idle");
      expect(activities[0]()).toEqual(["background shell jobs"]);
      await client.connectModel({ ...input, model: "B" });
      summary = client.compactSession({ sessionId: "session", force: true });
      await vi.waitFor(() => {
        expect(
          waitingNotices.some((notice) =>
            notice.includes("background shell jobs"),
          ),
        ).toBe(true);
      });
      expect(summaryModels).toEqual([]);
      expect(disposed).toEqual([]);
      await writeFile(join(workdir, ".release-background"), "release");
      await summaryStarted.promise;
      expect(summaryModels).toEqual(["B"]);
      expect(disposed).toEqual(["A"]);
      await client.connectModel({ ...input, model: "C" });
      const next = await client.submitPromptAccepted(
        "Continue after the summary",
        { sessionId: "next" },
      );
      await vi.waitFor(() => {
        expect(
          waitingNotices.some((notice) => notice.includes("context summaries")),
        ).toBe(true);
      });
      expect(disposed).toEqual(["A"]);
      releaseSummary.resolve();
      expect((await summary).status).toBe("compacted");
      expect((await client.waitForPrompt(next.promptId)).prompt.status).toBe(
        "succeeded",
      );
      expect(disposed).toEqual(["A", "B"]);
    } finally {
      await writeFile(join(workdir, ".release-background"), "release");
      releaseSummary.resolve();
      await summary?.catch(() => undefined);
      await client.dispose();
      compositionSpy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
